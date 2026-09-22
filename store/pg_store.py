"""PostgreSQL 版的資料存取。

對外提供的函式與 app.py 目前的檔案版同名同簽章，回傳結構也刻意做成
**與 data.json / process_groups.json / … 一模一樣**。

這條約束是整個遷移的關鍵：只要 `load_current_data()` 回傳的巢狀中文 JSON
與檔案版逐位元組相同，前端 data.js、Excel 匯出、building_data_manager 的所有
邏輯與現有測試就完全不用改，驗收也只需要比對 `dataset_revision()` 的 hash。
"""

import re
from typing import Any, Dict, List, Optional

from psycopg.types.json import Jsonb

import db
from building_data_manager import _parse_year  # 年份解析規則只保留這一份實作


class RevisionConflict(RuntimeError):
    """資料已被其他人更新（對應現行 API 的 409）。"""

    def __init__(self, current_revision: str):
        super().__init__("資料已被其他管理人員更新，請重新載入後再修改。")
        self.current_revision = current_revision


# =============================================================================
# 小工具
# =============================================================================

def _text(value: Any) -> str:
    return '' if value is None else str(value).strip()


def _number(value: Any) -> float:
    if value in (None, ''):
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _floor_weight(floor_name: Any) -> Optional[float]:
    """樓層排序權重。與前端 static/js/utils.js 的 getFloorWeight() 同一套規則。

    落地到資料庫是為了讓 building_mgmt 的 view 也能正確排序，
    外部 BI 不需要自己重寫一次樓層排序邏輯。
    """
    text = _text(floor_name).upper()
    if not text:
        return None
    if text == 'ALL':
        return 9999.0
    digits = re.sub(r'[^0-9]', '', text)
    number = int(digits) if digits else 0
    if text.startswith('B'):
        return float(-(number or 1))
    if text.startswith('R') or text == 'PH':
        return float(100 + (number or 1))
    return float(number)


# =============================================================================
# 建物資料：讀取
# =============================================================================

# 直接在資料庫端把三張表組成 data.json 的巢狀結構，一次查詢就拿到可用的格式。
# 數值一律 ::float8，避免 numeric 轉成 Python Decimal 之後序列化出 "100.0000"
# 這種字串，導致 dataset_revision 的 hash 跟檔案版對不起來。
_LOAD_DATASET_SQL = """
SELECT COALESCE(jsonb_agg(t.doc ORDER BY t.sort_order, t.building_code), '[]'::jsonb)
FROM (
    SELECT
        b.sort_order,
        b.building_code,
        jsonb_build_object(
            '_building_id',   b.building_id,
            '棟別',           b.building_code,
            '基地面積(M2)',   b.site_area_m2::float8,
            '容積率',         b.floor_area_ratio::float8,
            '建蔽率',         b.building_coverage_ratio::float8,
            '開挖深度(M)',    b.excavation_depth_m::float8,
            '耐震係數(gal)',  b.seismic_coefficient_gal::float8,
            '汽車停車位',     b.car_parking_spaces::float8,
            '機車停車位',     b.motorcycle_parking_spaces::float8,
            '樓層', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        '_floor_id',                 f.floor_id,
                        '樓層',                      f.floor_name,
                        '狀態',                      f.status::text,
                        '預計成廠年份',              f.expected_completion_year_raw,
                        '進駐製程',                  f.process_name,
                        '樓層高度(cm)',              f.floor_height_cm,
                        '無塵室淨高(cm)',            f.cleanroom_clear_height_cm,
                        '樓地板面積(M2)',            f.floor_area_m2::float8,
                        '無塵室面積(M2)',            f.cleanroom_area_m2::float8,
                        '生產週邊(M2)',              f.production_support_area_m2::float8,
                        '公設(含其他)(公式)(M2)',    f.public_area_m2::float8,
                        '樓層載重kgf/m2',            f.floor_load_kgf_m2::float8,
                        '廠務設施面積(M2)', jsonb_build_object(
                            'value',   f.facility_area_m2::float8,
                            'details', COALESCE((
                                SELECT jsonb_object_agg(a.facility_key, a.area_m2::float8)
                                FROM building_mgmt.floor_facility_areas a
                                WHERE a.floor_id = f.floor_id
                            ), '{}'::jsonb)
                        )
                    )
                    ORDER BY f.sort_order, f.floor_name
                )
                FROM building_mgmt.floors f
                WHERE f.building_id = b.building_id
            ), '[]'::jsonb)
        ) AS doc
    FROM building_mgmt.buildings b
) t
"""


def load_current_data() -> List[Dict[str, Any]]:
    """回傳與 data.json 同構的巢狀建物資料。"""
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(_LOAD_DATASET_SQL)
            return cur.fetchone()[0] or []


def current_revision() -> str:
    """目前資料集的 revision（樂觀鎖用）。"""
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT revision FROM building_mgmt.dataset_state WHERE id = 1")
            row = cur.fetchone()
            return row[0] if row else ''


# =============================================================================
# 建物資料：寫入
# =============================================================================

def _building_rows(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [
        {
            'building_id': _text(b.get('_building_id')),
            'building_code': _text(b.get('棟別')),
            'site_area_m2': _number(b.get('基地面積(M2)')),
            'floor_area_ratio': _number(b.get('容積率')),
            'building_coverage_ratio': _number(b.get('建蔽率')),
            'excavation_depth_m': _number(b.get('開挖深度(M)')),
            'seismic_coefficient_gal': _number(b.get('耐震係數(gal)')),
            'car_parking_spaces': _number(b.get('汽車停車位')),
            'motorcycle_parking_spaces': _number(b.get('機車停車位')),
            'sort_order': index,
        }
        for index, b in enumerate(data)
    ]


def _floor_rows(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for building in data:
        building_id = _text(building.get('_building_id'))
        for index, floor in enumerate(building.get('樓層') or []):
            raw_year = _text(floor.get('預計成廠年份'))
            year_num, _ = _parse_year(raw_year)
            facility = floor.get('廠務設施面積(M2)') or {}
            if not isinstance(facility, dict):
                facility = {'value': facility, 'details': {}}
            status = _text(floor.get('狀態')) or '已成廠'
            rows.append({
                'floor_id': _text(floor.get('_floor_id')),
                'building_id': building_id,
                'floor_name': _text(floor.get('樓層')),
                'floor_weight': _floor_weight(floor.get('樓層')),
                'status': status if status in ('已成廠', '未成廠') else '已成廠',
                'expected_completion_year_raw': raw_year,
                # 0 代表「現況／沒填」，存 NULL 讓統計查詢好寫
                'expected_completion_year_num': year_num or None,
                'process_name': _text(floor.get('進駐製程')),
                'floor_height_cm': _text(floor.get('樓層高度(cm)')),
                'cleanroom_clear_height_cm': _text(floor.get('無塵室淨高(cm)')),
                'floor_area_m2': _number(floor.get('樓地板面積(M2)')),
                'cleanroom_area_m2': _number(floor.get('無塵室面積(M2)')),
                'production_support_area_m2': _number(floor.get('生產週邊(M2)')),
                'public_area_m2': _number(floor.get('公設(含其他)(公式)(M2)')),
                'facility_area_m2': _number(facility.get('value')),
                'floor_load_kgf_m2': _number(floor.get('樓層載重kgf/m2')),
                'sort_order': index,
            })
    return rows


def _facility_rows(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rows = []
    for building in data:
        for floor in building.get('樓層') or []:
            facility = floor.get('廠務設施面積(M2)') or {}
            if not isinstance(facility, dict):
                continue
            for key, value in (facility.get('details') or {}).items():
                key_text = _text(key)
                if not key_text:
                    continue
                rows.append({
                    'floor_id': _text(floor.get('_floor_id')),
                    'facility_key': key_text,
                    'area_m2': _number(value),
                })
    return rows


_MERGE_BUILDINGS_SQL = """
MERGE INTO building_mgmt.buildings t
USING (
    SELECT * FROM jsonb_to_recordset(%(payload)s) AS x(
        building_id               text,
        building_code             text,
        site_area_m2              numeric,
        floor_area_ratio          numeric,
        building_coverage_ratio   numeric,
        excavation_depth_m        numeric,
        seismic_coefficient_gal   numeric,
        car_parking_spaces        numeric,
        motorcycle_parking_spaces numeric,
        sort_order                integer
    )
) s ON t.building_id = s.building_id
WHEN MATCHED THEN UPDATE SET
    building_code             = s.building_code,
    site_area_m2              = s.site_area_m2,
    floor_area_ratio          = s.floor_area_ratio,
    building_coverage_ratio   = s.building_coverage_ratio,
    excavation_depth_m        = s.excavation_depth_m,
    seismic_coefficient_gal   = s.seismic_coefficient_gal,
    car_parking_spaces        = s.car_parking_spaces,
    motorcycle_parking_spaces = s.motorcycle_parking_spaces,
    sort_order                = s.sort_order,
    updated_at                = now()
WHEN NOT MATCHED THEN INSERT (
    building_id, building_code, site_area_m2, floor_area_ratio, building_coverage_ratio,
    excavation_depth_m, seismic_coefficient_gal, car_parking_spaces,
    motorcycle_parking_spaces, sort_order
) VALUES (
    s.building_id, s.building_code, s.site_area_m2, s.floor_area_ratio, s.building_coverage_ratio,
    s.excavation_depth_m, s.seismic_coefficient_gal, s.car_parking_spaces,
    s.motorcycle_parking_spaces, s.sort_order
)
"""

_MERGE_FLOORS_SQL = """
MERGE INTO building_mgmt.floors t
USING (
    SELECT * FROM jsonb_to_recordset(%(payload)s) AS x(
        floor_id                     text,
        building_id                  text,
        floor_name                   text,
        floor_weight                 numeric,
        status                       text,
        expected_completion_year_raw text,
        expected_completion_year_num smallint,
        process_name                 text,
        floor_height_cm              text,
        cleanroom_clear_height_cm    text,
        floor_area_m2                numeric,
        cleanroom_area_m2            numeric,
        production_support_area_m2   numeric,
        public_area_m2               numeric,
        facility_area_m2             numeric,
        floor_load_kgf_m2            numeric,
        sort_order                   integer
    )
) s ON t.floor_id = s.floor_id
WHEN MATCHED THEN UPDATE SET
    building_id                  = s.building_id,
    floor_name                   = s.floor_name,
    floor_weight                 = s.floor_weight,
    status                       = s.status::building_mgmt.floor_status,
    expected_completion_year_raw = s.expected_completion_year_raw,
    expected_completion_year_num = s.expected_completion_year_num,
    process_name                 = s.process_name,
    floor_height_cm              = s.floor_height_cm,
    cleanroom_clear_height_cm    = s.cleanroom_clear_height_cm,
    floor_area_m2                = s.floor_area_m2,
    cleanroom_area_m2            = s.cleanroom_area_m2,
    production_support_area_m2   = s.production_support_area_m2,
    public_area_m2               = s.public_area_m2,
    facility_area_m2             = s.facility_area_m2,
    floor_load_kgf_m2            = s.floor_load_kgf_m2,
    sort_order                   = s.sort_order,
    updated_at                   = now()
WHEN NOT MATCHED THEN INSERT (
    floor_id, building_id, floor_name, floor_weight, status,
    expected_completion_year_raw, expected_completion_year_num, process_name,
    floor_height_cm, cleanroom_clear_height_cm, floor_area_m2, cleanroom_area_m2,
    production_support_area_m2, public_area_m2, facility_area_m2, floor_load_kgf_m2, sort_order
) VALUES (
    s.floor_id, s.building_id, s.floor_name, s.floor_weight, s.status::building_mgmt.floor_status,
    s.expected_completion_year_raw, s.expected_completion_year_num, s.process_name,
    s.floor_height_cm, s.cleanroom_clear_height_cm, s.floor_area_m2, s.cleanroom_area_m2,
    s.production_support_area_m2, s.public_area_m2, s.facility_area_m2, s.floor_load_kgf_m2, s.sort_order
)
"""


_UPDATE_STATE_SQL = """
UPDATE building_mgmt.dataset_state
   SET revision = %(revision)s,
       building_count = %(buildings)s,
       floor_count = %(floors)s,
       updated_at = now(),
       updated_by = %(username)s
 WHERE id = 1 {revision_guard}
{returning}
"""

# PG 18 起 RETURNING 可以引用 OLD / NEW。
_RETURNING_OLD_REVISION = "RETURNING OLD.revision AS revision_before"

# RETURNING OLD 的最低版本（18.0）
_MIN_RETURNING_OLD_VERSION = 180000


def _claim_dataset_state(cur, *, new_revision, counts, username, expected_revision):
    """取得版本列的鎖、檢查樂觀鎖並寫入新版本，回傳異動前的 revision。

    這一步同時扮演三個角色：
      1. 樂觀鎖：revision 對不上就是有人搶先改過 → RevisionConflict（對應 409）
      2. 序列化：拿到這一列的 row lock 之後，後續寫入不可能與別人交錯，
         所以整個存檔流程不需要額外的 advisory lock
      3. 稽核：順手取得異動前的 revision

    PG 18 可以用一條 UPDATE ... RETURNING OLD 一次做完；
    更舊的版本沒有 RETURNING OLD，改成 SELECT ... FOR UPDATE 再 UPDATE。
    兩者取得的是同一把 row lock，序列化效果相同，只差一次往返。
    """
    params = {
        'revision': new_revision,
        'buildings': counts.get('buildings', 0),
        'floors': counts.get('floors', 0),
        'username': username,
    }

    if cur.connection.info.server_version >= _MIN_RETURNING_OLD_VERSION:
        if expected_revision is None:
            guard = ''
        else:
            guard = 'AND revision = %(expected)s'
            params['expected'] = expected_revision
        cur.execute(
            _UPDATE_STATE_SQL.format(revision_guard=guard, returning=_RETURNING_OLD_REVISION),
            params,
        )
        row = cur.fetchone()
        if row is None:
            # 交易還沒結束，這裡讀到的就是搶先者已提交的值
            cur.execute("SELECT revision FROM building_mgmt.dataset_state WHERE id = 1")
            found = cur.fetchone()
            raise RevisionConflict(found[0] if found else '')
        return row[0]

    cur.execute("SELECT revision FROM building_mgmt.dataset_state WHERE id = 1 FOR UPDATE")
    row = cur.fetchone()
    revision_before = row[0] if row else ''
    if expected_revision is not None and revision_before != expected_revision:
        raise RevisionConflict(revision_before)
    cur.execute(_UPDATE_STATE_SQL.format(revision_guard='', returning=''), params)
    return revision_before


def save_current_data(
    data: List[Dict[str, Any]],
    *,
    new_revision: str,
    counts: Dict[str, int],
    username: str,
    expected_revision: Optional[str] = None,
    audit: Optional[Dict[str, Any]] = None,
    snapshot: bool = True,
) -> str:
    """整包覆寫建物資料，回傳異動前的 revision。

    `expected_revision` 有帶時做樂觀鎖檢查，對不上就丟 RevisionConflict（對應 409）；
    帶 None 代表不檢查（只有初次遷移會這樣用）。
    """
    building_rows = _building_rows(data)
    floor_rows = _floor_rows(data)
    facility_rows = _facility_rows(data)

    with db.transaction() as cur:
        # 整包覆寫時可能出現「兩棟互換名稱」，唯一鍵若在語句中途檢查會誤判重複，
        # 延到 COMMIT 才檢查才正確。
        cur.execute("SET CONSTRAINTS ALL DEFERRED")

        # 第一件事就是處理版本列：樂觀鎖、序列化與取得異動前的 revision 一次完成
        revision_before = _claim_dataset_state(
            cur,
            new_revision=new_revision,
            counts=counts,
            username=username,
            expected_revision=expected_revision,
        )

        # 建物：先 upsert 再刪掉不在清單裡的（刪除會連帶 cascade 掉底下的樓層）
        cur.execute(_MERGE_BUILDINGS_SQL, {'payload': Jsonb(building_rows)})
        cur.execute(
            "DELETE FROM building_mgmt.buildings WHERE building_id <> ALL(%(ids)s)",
            {'ids': [r['building_id'] for r in building_rows]},
        )

        cur.execute(_MERGE_FLOORS_SQL, {'payload': Jsonb(floor_rows)})
        cur.execute(
            "DELETE FROM building_mgmt.floors WHERE floor_id <> ALL(%(ids)s)",
            {'ids': [r['floor_id'] for r in floor_rows]},
        )

        # 廠務設施明細筆數少，整批重寫比逐筆比對簡單也不容易出錯
        cur.execute("DELETE FROM building_mgmt.floor_facility_areas")
        if facility_rows:
            cur.execute(
                """
                INSERT INTO building_mgmt.floor_facility_areas (floor_id, facility_key, area_m2)
                SELECT * FROM jsonb_to_recordset(%(payload)s)
                    AS x(floor_id text, facility_key text, area_m2 numeric)
                """,
                {'payload': Jsonb(facility_rows)},
            )

        if snapshot:
            cur.execute(
                """
                INSERT INTO building_mgmt.dataset_snapshots (revision, doc, counts, created_by)
                VALUES (%(revision)s, %(doc)s, %(counts)s, %(username)s)
                ON CONFLICT (revision) DO NOTHING
                """,
                {
                    'revision': new_revision,
                    'doc': Jsonb(data),
                    'counts': Jsonb(counts),
                    'username': username,
                },
            )

        if audit:
            cur.execute(
                """
                INSERT INTO building_mgmt.data_change_log (
                    changed_at, effective_date, change_type, changed_by, reason,
                    source_reference, revision_before, revision_after, backup_file,
                    summary, counts
                ) VALUES (
                    COALESCE(%(changed_at)s::timestamptz, now()), %(effective_date)s,
                    %(change_type)s, %(changed_by)s, %(reason)s, %(source_reference)s,
                    %(revision_before)s, %(revision_after)s, %(backup_file)s,
                    %(summary)s, %(counts)s
                )
                """,
                {
                    'changed_at': audit.get('changed_at'),
                    'effective_date': audit.get('effective_date'),
                    'change_type': audit.get('change_type'),
                    'changed_by': audit.get('changed_by') or username,
                    'reason': audit.get('reason') or '',
                    'source_reference': audit.get('source_reference') or '',
                    'revision_before': audit.get('revision_before') or revision_before,
                    'revision_after': audit.get('revision_after') or new_revision,
                    'backup_file': audit.get('backup_file'),
                    'summary': Jsonb(audit.get('summary') or {}),
                    'counts': Jsonb(audit.get('counts') or counts),
                },
            )

    return revision_before


def load_audit_records(limit: int = 1000) -> List[Dict[str, Any]]:
    """回傳與 data_changes.json 同構的稽核紀錄（舊到新）。"""
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT changed_at, effective_date, change_type, changed_by, reason,
                       source_reference, revision_before, revision_after, backup_file,
                       summary, counts
                FROM (
                    SELECT * FROM building_mgmt.data_change_log
                    ORDER BY change_id DESC LIMIT %(limit)s
                ) recent
                ORDER BY change_id
                """,
                {'limit': limit},
            )
            return [
                {
                    'changed_at': row[0].isoformat(timespec='seconds') if row[0] else '',
                    'effective_date': row[1].isoformat() if row[1] else '',
                    'change_type': row[2],
                    'changed_by': row[3],
                    'reason': row[4],
                    'source_reference': row[5],
                    'revision_before': row[6],
                    'revision_after': row[7],
                    'backup_file': row[8],
                    'summary': row[9],
                    'counts': row[10],
                }
                for row in cur.fetchall()
            ]


# =============================================================================
# 設定類：製程大群組 / 趨勢比較基準 / 需求趨勢
# =============================================================================

def _load_setting(key: str, default: Any) -> Any:
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT value FROM building_mgmt.app_settings WHERE setting_key = %s", (key,)
            )
            row = cur.fetchone()
            return row[0] if row else default


def _save_setting(cur, key: str, value: Any, username: Optional[str]) -> None:
    cur.execute(
        """
        INSERT INTO building_mgmt.app_settings (setting_key, value, updated_at, updated_by)
        VALUES (%(key)s, %(value)s, now(), %(username)s)
        ON CONFLICT (setting_key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by
        """,
        {'key': key, 'value': Jsonb(value), 'username': username},
    )


def load_process_groups() -> Dict[str, Any]:
    meta = _load_setting('process_groups_meta', {}) or {}
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT g.group_id, g.group_name,
                       COALESCE(array_agg(m.process_name
                                          ORDER BY m.sort_order, m.process_name)
                                FILTER (WHERE m.process_name IS NOT NULL), '{}')
                FROM building_mgmt.process_groups g
                LEFT JOIN building_mgmt.process_group_members m ON m.group_id = g.group_id
                GROUP BY g.group_id, g.group_name, g.sort_order
                ORDER BY g.sort_order, g.group_name
                """
            )
            groups = [
                {'id': row[0], 'name': row[1], 'processes': list(row[2])}
                for row in cur.fetchall()
            ]
    return {
        'schema_version': meta.get('schema_version', '1.0'),
        'updated_at': meta.get('updated_at'),
        'updated_by': meta.get('updated_by'),
        'groups': groups,
    }


def write_process_groups(data: Dict[str, Any], username: Optional[str] = None) -> None:
    groups = data.get('groups') or []
    with db.transaction() as cur:
        cur.execute("SET CONSTRAINTS ALL DEFERRED")
        cur.execute(
            """
            INSERT INTO building_mgmt.process_groups (group_id, group_name, sort_order, updated_at, updated_by)
            SELECT x.group_id, x.group_name, x.sort_order, now(), %(username)s
            FROM jsonb_to_recordset(%(payload)s)
                AS x(group_id text, group_name text, sort_order integer)
            ON CONFLICT (group_id) DO UPDATE
               SET group_name = EXCLUDED.group_name,
                   sort_order = EXCLUDED.sort_order,
                   updated_at = EXCLUDED.updated_at,
                   updated_by = EXCLUDED.updated_by
            """,
            {
                'payload': Jsonb([
                    {
                        'group_id': _text(g.get('id')),
                        'group_name': _text(g.get('name')),
                        'sort_order': index,
                    }
                    for index, g in enumerate(groups)
                ]),
                'username': username,
            },
        )
        cur.execute(
            "DELETE FROM building_mgmt.process_groups WHERE group_id <> ALL(%(ids)s)",
            {'ids': [_text(g.get('id')) for g in groups]},
        )

        # 成員整批重寫：製程分群是小表，而且 process_name 是主鍵，
        # 逐筆搬移比整批重建更容易踩到唯一鍵衝突。
        cur.execute("DELETE FROM building_mgmt.process_group_members")
        members = [
            {'process_name': _text(p), 'group_id': _text(g.get('id')), 'sort_order': index}
            for g in groups
            for index, p in enumerate(g.get('processes') or [])
            if _text(p)
        ]
        if members:
            cur.execute(
                """
                INSERT INTO building_mgmt.process_group_members (process_name, group_id, sort_order)
                SELECT * FROM jsonb_to_recordset(%(payload)s)
                    AS x(process_name text, group_id text, sort_order integer)
                """,
                {'payload': Jsonb(members)},
            )

        _save_setting(cur, 'process_groups_meta', {
            'schema_version': data.get('schema_version', '1.0'),
            'updated_at': data.get('updated_at'),
            'updated_by': data.get('updated_by'),
        }, username)


def load_trend_reference() -> Dict[str, Any]:
    return _load_setting('trend_reference', {
        'schema_version': '1.0',
        'updated_at': None,
        'updated_by': None,
        'buildings': [],
    })


def write_trend_reference(data: Dict[str, Any], username: Optional[str] = None) -> None:
    with db.transaction() as cur:
        _save_setting(cur, 'trend_reference', data, username)


def load_utility_trends() -> Dict[str, Any]:
    meta = _load_setting('utility_trends_meta', {}) or {}
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT m.metric_key, m.metric_name, m.unit, m.annual_label,
                       m.cumulative_label, m.description,
                       COALESCE(jsonb_agg(
                           jsonb_build_object(
                               'year_key',    p.year_key,
                               'year_label',  p.year_label,
                               'value',       p.value::float8,
                               'is_baseline', p.is_baseline,
                               'note',        p.note
                           ) ORDER BY p.sort_order, p.year_key
                       ) FILTER (WHERE p.year_key IS NOT NULL), '[]'::jsonb)
                FROM building_mgmt.utility_metrics m
                LEFT JOIN building_mgmt.utility_metric_points p ON p.metric_key = m.metric_key
                GROUP BY m.metric_key, m.metric_name, m.unit, m.annual_label,
                         m.cumulative_label, m.description, m.sort_order
                ORDER BY m.sort_order, m.metric_key
                """
            )
            metrics = [
                {
                    'metric_key': row[0],
                    'metric_name': row[1],
                    'unit': row[2],
                    'annual_label': row[3],
                    'cumulative_label': row[4],
                    'description': row[5],
                    'series': row[6],
                }
                for row in cur.fetchall()
            ]
    # meta 存的就是寫入當下除了 metrics 以外的所有 top-level 欄位，
    # 原樣放回去才能與檔案版逐鍵相同（例如來源沒有 description 就不該憑空補一個）。
    result = dict(meta) if meta else {'schema_version': '1.0', 'updated_at': None, 'updated_by': None}
    result['metrics'] = metrics
    return result


def write_utility_trends(data: Dict[str, Any], username: Optional[str] = None) -> None:
    metrics = data.get('metrics') or []
    with db.transaction() as cur:
        cur.execute(
            """
            INSERT INTO building_mgmt.utility_metrics (
                metric_key, metric_name, unit, annual_label, cumulative_label,
                description, sort_order
            )
            SELECT x.metric_key, x.metric_name, x.unit, x.annual_label,
                   x.cumulative_label, x.description, x.sort_order
            FROM jsonb_to_recordset(%(payload)s) AS x(
                metric_key text, metric_name text, unit text, annual_label text,
                cumulative_label text, description text, sort_order integer
            )
            ON CONFLICT (metric_key) DO UPDATE
               SET metric_name      = EXCLUDED.metric_name,
                   unit             = EXCLUDED.unit,
                   annual_label     = EXCLUDED.annual_label,
                   cumulative_label = EXCLUDED.cumulative_label,
                   description      = EXCLUDED.description,
                   sort_order       = EXCLUDED.sort_order
            """,
            {
                'payload': Jsonb([
                    {
                        'metric_key': _text(m.get('metric_key')),
                        'metric_name': _text(m.get('metric_name')),
                        'unit': _text(m.get('unit')),
                        'annual_label': _text(m.get('annual_label')),
                        'cumulative_label': _text(m.get('cumulative_label')),
                        'description': _text(m.get('description')),
                        'sort_order': index,
                    }
                    for index, m in enumerate(metrics)
                ]),
            },
        )
        cur.execute(
            "DELETE FROM building_mgmt.utility_metrics WHERE metric_key <> ALL(%(keys)s)",
            {'keys': [_text(m.get('metric_key')) for m in metrics]},
        )

        points = [
            {
                'metric_key': _text(m.get('metric_key')),
                'year_key': _text(p.get('year_key')),
                'year_label': _text(p.get('year_label')),
                'value': _number(p.get('value')),
                'is_baseline': bool(p.get('is_baseline')),
                'note': _text(p.get('note')),
                'sort_order': index,
            }
            for m in metrics
            for index, p in enumerate(m.get('series') or [])
            if _text(p.get('year_key'))
        ]
        cur.execute("DELETE FROM building_mgmt.utility_metric_points")
        if points:
            cur.execute(
                """
                INSERT INTO building_mgmt.utility_metric_points (
                    metric_key, year_key, year_label, value, is_baseline, note, sort_order
                )
                SELECT * FROM jsonb_to_recordset(%(payload)s) AS x(
                    metric_key text, year_key text, year_label text, value numeric,
                    is_baseline boolean, note text, sort_order integer
                )
                """,
                {'payload': Jsonb(points)},
            )

        # metrics 已經存進關聯式表，其餘 top-level 欄位原樣留存，讀回來才不會走樣
        _save_setting(cur, 'utility_trends_meta',
                      {k: v for k, v in data.items() if k != 'metrics'}, username)


# =============================================================================
# 權限
# =============================================================================

_ROLE_TO_BUCKET = {'admin': 'admins', 'user': 'users', 'viewer': 'viewers'}


def load_permissions() -> Dict[str, List[str]]:
    """回傳與 permissions.json 同構的名單。"""
    permissions = {'admins': [], 'users': [], 'viewers': []}
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT role::text, identity_key
                FROM building_mgmt.user_roles
                WHERE is_active
                ORDER BY role, identity_key
                """
            )
            for role, identity_key in cur.fetchall():
                bucket = _ROLE_TO_BUCKET.get(role)
                if bucket:
                    permissions[bucket].append(identity_key)
    return permissions


def find_role(identity_variants: List[str]) -> Optional[str]:
    """依 identity_variants() 產生的所有寫法查角色。

    完整寫法與去網域的短寫法兩邊都比，對應現行 get_user_role() 的雙向交集判斷。
    enum 的宣告順序是 admin > user > viewer，所以 ORDER BY role 就是優先序。
    """
    variants = [v for v in identity_variants if v]
    if not variants:
        return None
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT role::text
                FROM building_mgmt.user_roles
                WHERE is_active
                  AND (identity_key = ANY(%(variants)s) OR account_key = ANY(%(variants)s))
                ORDER BY role
                LIMIT 1
                """,
                {'variants': variants},
            )
            row = cur.fetchone()
            return row[0] if row else None


def write_permissions(permissions: Dict[str, List[str]], username: Optional[str] = None) -> None:
    """整批覆寫權限名單（格式同 permissions.json）。"""
    rows = [
        {'identity_key': _text(name).lower(), 'role': role}
        for role, bucket in (('admin', 'admins'), ('user', 'users'), ('viewer', 'viewers'))
        for name in (permissions.get(bucket) or [])
        if _text(name)
    ]
    # 同一個人重複出現時保留權限較高的那筆（admin > user > viewer）
    deduped = {}
    for row in rows:
        existing = deduped.get(row['identity_key'])
        order = {'admin': 0, 'user': 1, 'viewer': 2}
        if existing is None or order[row['role']] < order[existing['role']]:
            deduped[row['identity_key']] = row
    rows = list(deduped.values())

    with db.transaction() as cur:
        if rows:
            cur.execute(
                """
                INSERT INTO building_mgmt.user_roles (identity_key, role, created_by, updated_by)
                SELECT x.identity_key, x.role::building_mgmt.user_role, %(username)s, %(username)s
                FROM jsonb_to_recordset(%(payload)s) AS x(identity_key text, role text)
                ON CONFLICT (identity_key) DO UPDATE
                   SET role = EXCLUDED.role,
                       is_active = true,
                       updated_at = now(),
                       updated_by = EXCLUDED.updated_by
                """,
                {'payload': Jsonb(rows), 'username': username},
            )
        cur.execute(
            "DELETE FROM building_mgmt.user_roles WHERE identity_key <> ALL(%(keys)s)",
            {'keys': [r['identity_key'] for r in rows]},
        )


# =============================================================================
# 存取紀錄
# =============================================================================

def append_access_log(username, action, client_ip=None, detail='', identity_key='', role=''):
    """寫一筆存取紀錄。

    呼叫端負責確保寫入失敗不會讓使用者的請求失敗 —— 記錄使用者行為的重要性，
    永遠低於讓使用者能正常使用系統。
    """
    with db.transaction() as cur:
        cur.execute(
            """
            INSERT INTO building_mgmt.access_log
                (username, identity_key, role, action, client_ip, detail)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (username or '', identity_key or '', role or '', action, client_ip, detail or ''),
        )


# =============================================================================
# 欄位字典
# =============================================================================

def load_data_dictionary() -> List[tuple]:
    """回傳欄位字典，格式與 DATA_DICTIONARY_ROWS 相同。"""
    with db.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT object_name, field_name, description, data_type, rule_or_unit, sort_order
                FROM building_mgmt.data_dictionary
                ORDER BY object_name, sort_order, field_name
                """
            )
            return [tuple(row) for row in cur.fetchall()]


def sync_data_dictionary(rows) -> int:
    """把程式裡的欄位字典同步到資料庫，回傳同步的筆數。

    定義只寫在 building_data_manager.DATA_DICTIONARY_ROWS 一處，
    這裡負責把它推到資料庫，供 building_mgmt.v_data_dictionary 給外部查詢。
    程式裡已經沒有的項目會一併刪掉，避免留下過期說明。
    """
    payload = [
        {
            'object_name': row[0], 'field_name': row[1], 'description': row[2],
            'data_type': row[3], 'rule_or_unit': row[4],
            'sort_order': row[5] if len(row) > 5 else 0,
        }
        for row in rows
    ]
    with db.transaction() as cur:
        if payload:
            cur.execute(
                """
                INSERT INTO building_mgmt.data_dictionary
                    (object_name, field_name, description, data_type, rule_or_unit, sort_order)
                SELECT * FROM jsonb_to_recordset(%(payload)s) AS x(
                    object_name text, field_name text, description text,
                    data_type text, rule_or_unit text, sort_order integer
                )
                ON CONFLICT (object_name, field_name) DO UPDATE
                   SET description  = EXCLUDED.description,
                       data_type    = EXCLUDED.data_type,
                       rule_or_unit = EXCLUDED.rule_or_unit,
                       sort_order   = EXCLUDED.sort_order
                """,
                {'payload': Jsonb(payload)},
            )
        cur.execute(
            """
            DELETE FROM building_mgmt.data_dictionary d
             WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_to_recordset(%(payload)s)
                     AS x(object_name text, field_name text)
                  WHERE x.object_name = d.object_name AND x.field_name = d.field_name
             )
            """,
            {'payload': Jsonb(payload)},
        )
    return len(payload)


def ensure_access_log_partitions(months_ahead: int = 1) -> List[str]:
    """補建本月起算的月份分割，回傳分割表名稱。部署與排程可直接呼叫。"""
    created = []
    with db.transaction() as cur:
        for offset in range(months_ahead + 1):
            cur.execute(
                "SELECT building_mgmt.ensure_access_log_partition("
                "(CURRENT_DATE + (%s || ' month')::interval)::date)",
                (offset,),
            )
            created.append(cur.fetchone()[0])
    return created


__all__ = [
    'RevisionConflict',
    'load_current_data', 'save_current_data', 'current_revision', 'load_audit_records',
    'load_process_groups', 'write_process_groups',
    'load_trend_reference', 'write_trend_reference',
    'load_utility_trends', 'write_utility_trends',
    'load_permissions', 'write_permissions', 'find_role',
    'load_data_dictionary', 'sync_data_dictionary',
    'append_access_log', 'ensure_access_log_partitions',
]
