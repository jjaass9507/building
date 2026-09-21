-- =============================================================================
-- 001_init.sql — 建物管理平台 PostgreSQL 初始 schema
--
-- 目標版本：PostgreSQL 18 以上
--   * 本檔使用 STORED generated column。PG 18 起 GENERATED ALWAYS AS (expr) 不寫
--     STORED 時預設是 VIRTUAL，而 VIRTUAL 欄位無法建索引，所以底下一律明寫 STORED。
--   * 應用程式端（store/pg_store.py）會用到 RETURNING OLD/NEW，這是 PG 18 的語法。
--
-- 設計原則：
--   1. 欄位命名沿用 building_data_manager.build_standard_workbook() 既有的英文對照，
--      Excel 匯出、DB 欄位、對外 view 三者用同一套名稱。
--   2. 面積一律 numeric 不用 float，避免大量 SUM 與百分比運算累積浮點誤差。
--   3. 「目前狀態」放關聯式表，「歷史版本」放 dataset_snapshots 的 jsonb，
--      不做 SCD-2 時序表（年度資訊是 floors 的欄位，不是紀錄的生效期間）。
--
-- 本檔可重複執行（idempotent）。
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS building;

-- -----------------------------------------------------------------------------
-- migration 版本紀錄（scripts/run-migrations.ps1 會讀寫這張表）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL DEFAULT current_user,
    checksum   text
);

-- -----------------------------------------------------------------------------
-- 建物主檔
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.buildings (
    building_id               text PRIMARY KEY,          -- 沿用現有 BLD-uuid5，不重新編號
    building_code             text NOT NULL,             -- 棟別
    site_area_m2              numeric(14,4) NOT NULL DEFAULT 0,
    floor_area_ratio          numeric(12,4) NOT NULL DEFAULT 0,
    building_coverage_ratio   numeric(12,4) NOT NULL DEFAULT 0,
    excavation_depth_m        numeric(12,4) NOT NULL DEFAULT 0,
    seismic_coefficient_gal   numeric(12,4) NOT NULL DEFAULT 0,
    car_parking_spaces        numeric(12,2) NOT NULL DEFAULT 0,
    motorcycle_parking_spaces numeric(12,2) NOT NULL DEFAULT 0,
    sort_order                integer NOT NULL DEFAULT 0,  -- 保留 data.json 的原始順序

    -- normalize_dataset() 用 casefold 判斷棟別重複，這裡用 lower() 落地同一條規則。
    -- 做成 STORED generated column 而不是 expression index，是為了能宣告成
    -- DEFERRABLE 的 UNIQUE constraint：整包覆寫時若兩棟互換名稱，
    -- IMMEDIATE 的唯一索引會在中途誤判重複，DEFERRED 才能撐到 COMMIT 才檢查。
    building_code_key text GENERATED ALWAYS AS (lower(building_code)) STORED,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT buildings_code_key UNIQUE (building_code_key) DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT buildings_code_not_blank CHECK (btrim(building_code) <> '')
);

-- -----------------------------------------------------------------------------
-- 樓層明細
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    CREATE TYPE building.floor_status AS ENUM ('已成廠', '未成廠');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS building.floors (
    floor_id     text PRIMARY KEY,                       -- 沿用現有 FLR-uuid5
    building_id  text NOT NULL
                 REFERENCES building.buildings(building_id) ON DELETE CASCADE,
    floor_name   text NOT NULL,
    floor_weight numeric(12,3),                          -- 前端 getFloorWeight() 的排序權重

    status building.floor_status NOT NULL DEFAULT '已成廠',

    -- 年份保留兩份：raw 給畫面顯示（現況／Y26／2026 三種寫法都可能），
    -- num 給查詢與統計用。num 由應用程式的 _parse_year() 寫入，不做成
    -- generated column —— 解析規則只能有一份實作，重複寫在 SQL 裡遲早會不一致。
    expected_completion_year_raw text     NOT NULL DEFAULT '',
    expected_completion_year_num smallint,

    process_name text NOT NULL DEFAULT '',

    -- 目前系統把高度當文字保存（保留來源格式），這裡照原樣不硬轉數字。
    floor_height_cm           text NOT NULL DEFAULT '',
    cleanroom_clear_height_cm text NOT NULL DEFAULT '',

    floor_area_m2              numeric(14,4) NOT NULL DEFAULT 0,
    cleanroom_area_m2          numeric(14,4) NOT NULL DEFAULT 0,
    production_support_area_m2 numeric(14,4) NOT NULL DEFAULT 0,
    public_area_m2             numeric(14,4) NOT NULL DEFAULT 0,
    facility_area_m2           numeric(14,4) NOT NULL DEFAULT 0,
    floor_load_kgf_m2          numeric(14,4) NOT NULL DEFAULT 0,

    sort_order integer NOT NULL DEFAULT 0,

    floor_name_key text GENERATED ALWAYS AS (lower(floor_name)) STORED,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT floors_building_name_key
        UNIQUE (building_id, floor_name_key) DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT floors_name_not_blank CHECK (btrim(floor_name) <> '')
);

CREATE INDEX IF NOT EXISTS floors_building_idx ON building.floors (building_id);
CREATE INDEX IF NOT EXISTS floors_process_idx  ON building.floors (process_name);
CREATE INDEX IF NOT EXISTS floors_year_idx     ON building.floors (expected_completion_year_num);

-- -----------------------------------------------------------------------------
-- 廠務設施面積明細
--
-- 用長表而不是 11 個寬欄位：_facility_value() 實際接受任意 key 的 dict，
-- 長表才是忠實對應。要寬表給 Excel / BI 時，由 building_api 的 view 做 pivot。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.floor_facility_areas (
    floor_id     text NOT NULL REFERENCES building.floors(floor_id) ON DELETE CASCADE,
    facility_key text NOT NULL,     -- 純水 / 廢水 / 給排水 / 空調 / … / 其他
    area_m2      numeric(14,4) NOT NULL DEFAULT 0,
    PRIMARY KEY (floor_id, facility_key)
);

-- -----------------------------------------------------------------------------
-- 製程大群組
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.process_groups (
    group_id   text PRIMARY KEY,
    group_name text NOT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    CONSTRAINT process_groups_name_key UNIQUE (group_name) DEFERRABLE INITIALLY IMMEDIATE
);

-- process_name 直接當 PK：validate_process_groups() 的「一個製程不可重複分群」
-- 這條規則就由資料庫保證，不必只靠應用層檢查。
CREATE TABLE IF NOT EXISTS building.process_group_members (
    process_name text PRIMARY KEY,
    group_id     text NOT NULL
                 REFERENCES building.process_groups(group_id) ON DELETE CASCADE,
    sort_order   integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS process_group_members_group_idx
    ON building.process_group_members (group_id);

-- -----------------------------------------------------------------------------
-- 電力／用水需求趨勢
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.utility_metrics (
    metric_key       text PRIMARY KEY,          -- power_demand / water_demand
    metric_name      text NOT NULL,
    unit             text NOT NULL DEFAULT '',  -- kW / CMD
    annual_label     text NOT NULL DEFAULT '',
    cumulative_label text NOT NULL DEFAULT '',
    description      text NOT NULL DEFAULT '',
    sort_order       integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS building.utility_metric_points (
    metric_key  text NOT NULL
                REFERENCES building.utility_metrics(metric_key) ON DELETE CASCADE,
    year_key    text NOT NULL,                  -- current / Y26 / Y27
    year_label  text NOT NULL,
    value       numeric(18,4) NOT NULL DEFAULT 0,
    is_baseline boolean NOT NULL DEFAULT false,
    note        text NOT NULL DEFAULT '',
    sort_order  integer NOT NULL DEFAULT 0,
    PRIMARY KEY (metric_key, year_key)
);

-- -----------------------------------------------------------------------------
-- 小型設定（trend_reference 的比較基準棟、display_settings 等）
-- 這類設定結構零散、筆數個位數，各開一張表不划算，統一放 key/value。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.app_settings (
    setting_key text PRIMARY KEY,
    value       jsonb NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text
);

-- -----------------------------------------------------------------------------
-- 權限
--
-- identity_variants() 的比對是雙向的：名單寫 ASE\K11879、登入者是 K11879 也要對得上。
-- 所以完整寫法與去網域的短寫法都要存，查詢時兩欄一起比。
-- -----------------------------------------------------------------------------
DO $$ BEGIN
    -- enum 的宣告順序就是排序順序，剛好等於 get_user_role() 的 admin > user > viewer 優先序
    CREATE TYPE building.user_role AS ENUM ('admin', 'user', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS building.user_roles (
    identity_key text PRIMARY KEY,               -- normalize_identity() 後的完整值（小寫）
    account_key  text GENERATED ALWAYS AS (
                     regexp_replace(regexp_replace(identity_key, '^.*\\', ''), '@.*$', '')
                 ) STORED,                       -- 去掉 網域\ 前綴與 @網域 後綴
    display_name text NOT NULL DEFAULT '',
    role         building.user_role NOT NULL,
    is_active    boolean NOT NULL DEFAULT true,
    note         text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text
);

CREATE INDEX IF NOT EXISTS user_roles_account_idx
    ON building.user_roles (account_key) WHERE is_active;

CREATE TABLE IF NOT EXISTS building.user_role_changes (
    change_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    changed_at   timestamptz NOT NULL DEFAULT now(),
    changed_by   text NOT NULL,
    identity_key text NOT NULL,
    role_before  building.user_role,
    role_after   building.user_role,
    reason       text NOT NULL DEFAULT ''
);

-- -----------------------------------------------------------------------------
-- 版本狀態（樂觀鎖）
--
-- 單列表。存檔時第一件事就是對這一列下條件式 UPDATE：
--   UPDATE dataset_state SET revision=新 WHERE id=1 AND revision=預期
--   RETURNING OLD.revision, NEW.revision;
-- 影響 0 列 → 有人搶先改過 → 回 409。
-- 這個 UPDATE 取得的 row lock 同時序列化了後續所有寫入，不需要額外的 advisory lock。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.dataset_state (
    id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    revision       text NOT NULL,
    building_count integer NOT NULL DEFAULT 0,
    floor_count    integer NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text
);

-- 空資料集的 revision = dataset_revision([]) = sha256('[]')。
-- 預先放進去，第一次開啟維護畫面時 GET 回傳的 revision 才對得上。
INSERT INTO building.dataset_state (id, revision, building_count, floor_count, updated_by)
VALUES (1, '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', 0, 0, 'system')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 版本快照（取代 data_backups/*.json）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.dataset_snapshots (
    revision   text PRIMARY KEY,
    doc        jsonb NOT NULL,        -- normalize_dataset() 後的整包資料
    counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
);

-- -----------------------------------------------------------------------------
-- 異動稽核（取代 data_changes.json）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.data_change_log (
    change_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    changed_at       timestamptz NOT NULL DEFAULT now(),
    effective_date   date NOT NULL,
    change_type      text NOT NULL,
    changed_by       text NOT NULL DEFAULT '',
    reason           text NOT NULL DEFAULT '',
    source_reference text NOT NULL DEFAULT '',
    revision_before  text,
    revision_after   text,
    backup_file      text,            -- 遷移前的舊備份檔名，遷移後為 NULL
    summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
    counts           jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT data_change_log_type_check CHECK (
        change_type IN ('ADD', 'ADJUST', 'EXPAND', 'REDUCE', 'DEMOLISH', 'IMPORT')
    )
);

CREATE INDEX IF NOT EXISTS data_change_log_changed_at_idx
    ON building.data_change_log (changed_at DESC);

-- -----------------------------------------------------------------------------
-- 存取紀錄（取代 access_log.txt）
--
-- 按月分割：舊資料直接 DETACH + DROP，不會無限長大。
-- 另備一個 DEFAULT 分割，萬一分割沒先建好也不會讓寫入失敗。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.access_log (
    log_id       bigint GENERATED ALWAYS AS IDENTITY,
    logged_at    timestamptz NOT NULL DEFAULT now(),
    username     text NOT NULL DEFAULT '',
    identity_key text NOT NULL DEFAULT '',
    role         text NOT NULL DEFAULT '',
    action       text NOT NULL,
    client_ip    inet,
    detail       text NOT NULL DEFAULT '',
    PRIMARY KEY (log_id, logged_at)
) PARTITION BY RANGE (logged_at);

CREATE TABLE IF NOT EXISTS building.access_log_default
    PARTITION OF building.access_log DEFAULT;

CREATE INDEX IF NOT EXISTS access_log_logged_at_idx
    ON building.access_log (logged_at DESC);

-- 建立（或補建）某個月份的分割。排程或部署腳本可以直接呼叫。
CREATE OR REPLACE FUNCTION building.ensure_access_log_partition(target date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    period_start date := date_trunc('month', target)::date;
    period_end   date := (date_trunc('month', target) + interval '1 month')::date;
    part_name    text := format('access_log_%s', to_char(period_start, 'YYYYMM'));
BEGIN
    IF to_regclass(format('building.%I', part_name)) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE building.%I PARTITION OF building.access_log
                 FOR VALUES FROM (%L) TO (%L)',
            part_name, period_start, period_end
        );
    END IF;
    RETURN part_name;
END;
$$;

-- 先把本月與下個月備好
SELECT building.ensure_access_log_partition(CURRENT_DATE);
SELECT building.ensure_access_log_partition((CURRENT_DATE + interval '1 month')::date);

-- -----------------------------------------------------------------------------
-- 欄位字典
--
-- 內容不寫在這裡：唯一定義處是 building_data_manager.DATA_DICTIONARY_ROWS，
-- 由 scripts/run_migrations.py 在套用 migration 之後同步進來。
-- 這樣 Excel 匯出與外部 BI 看到的是同一份說明，不會各自漂移。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS building.data_dictionary (
    object_name  text NOT NULL,      -- 對應的 view / sheet 名稱
    field_name   text NOT NULL,
    description  text NOT NULL,
    data_type    text NOT NULL DEFAULT '',
    rule_or_unit text NOT NULL DEFAULT '',
    sort_order   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (object_name, field_name)
);

COMMIT;
