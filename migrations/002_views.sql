-- =============================================================================
-- 002_views.sql — building_api 對外 view 層
--
-- 為什麼要多這一層：
--   BI / 報表工具會直接連這個資料庫。如果讓它們吃 building schema 的內部表，
--   之後任何一次重構都會打壞別人的報表。外部只看得到 building_api 的 view，
--   內部表怎麼改都能靠 view 維持相容。
--
-- 欄位命名與 build_standard_workbook() 匯出的 Excel 完全一致，
-- 讓「匯出報表」與「BI 查詢」是同一套語意。
--
-- 本檔可重複執行（idempotent）。
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS building_api;

-- -----------------------------------------------------------------------------
-- 建物主檔（對應 Excel 的 building_master 工作表）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_building_master AS
SELECT
    b.building_id,
    b.building_code,
    b.site_area_m2,
    b.floor_area_ratio,
    b.building_coverage_ratio,
    b.excavation_depth_m,
    b.seismic_coefficient_gal,
    b.car_parking_spaces,
    b.motorcycle_parking_spaces,
    (SELECT count(*) FROM building.floors f WHERE f.building_id = b.building_id) AS floor_count,
    (SELECT COALESCE(sum(f.floor_area_m2), 0)
       FROM building.floors f WHERE f.building_id = b.building_id)               AS total_floor_area_m2,
    b.updated_at
FROM building.buildings b;

-- -----------------------------------------------------------------------------
-- 樓層明細（對應 Excel 的 floor_area_detail 工作表）
--
-- 廠務設施明細在內部是長表，這裡 pivot 回 Excel 既有的寬欄位。
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_floor_area_detail AS
SELECT
    f.floor_id,
    f.building_id,
    b.building_code,
    f.floor_name,
    f.status::text                      AS status,
    f.expected_completion_year_raw      AS expected_completion_year,
    f.expected_completion_year_num,
    f.process_name,
    f.floor_height_cm,
    f.cleanroom_clear_height_cm,
    f.floor_area_m2,
    f.cleanroom_area_m2,
    f.production_support_area_m2,
    f.public_area_m2,
    f.facility_area_m2,
    COALESCE(a.pure_water,  0) AS facility_pure_water_m2,
    COALESCE(a.wastewater,  0) AS facility_wastewater_m2,
    COALESCE(a.plumbing,    0) AS facility_plumbing_m2,
    COALESCE(a.hvac,        0) AS facility_hvac_m2,
    COALESCE(a.exhaust,     0) AS facility_exhaust_m2,
    COALESCE(a.gas,         0) AS facility_gas_m2,
    COALESCE(a.power,       0) AS facility_power_m2,
    COALESCE(a.low_voltage, 0) AS facility_low_voltage_m2,
    COALESCE(a.fire,        0) AS facility_fire_m2,
    COALESCE(a.monitoring,  0) AS facility_monitoring_m2,
    COALESCE(a.other,       0) AS facility_other_m2,
    f.floor_load_kgf_m2,
    f.updated_at
FROM building.floors f
JOIN building.buildings b ON b.building_id = f.building_id
LEFT JOIN LATERAL (
    SELECT
        sum(x.area_m2) FILTER (WHERE x.facility_key = '純水')   AS pure_water,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '廢水')   AS wastewater,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '給排水') AS plumbing,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '空調')   AS hvac,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '抽氣')   AS exhaust,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '氣體')   AS gas,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '電力')   AS power,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '弱電')   AS low_voltage,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '消防')   AS fire,
        sum(x.area_m2) FILTER (WHERE x.facility_key = '監控')   AS monitoring,
        sum(x.area_m2) FILTER (WHERE x.facility_key NOT IN (
            '純水','廢水','給排水','空調','抽氣','氣體','電力','弱電','消防','監控'
        )) AS other
    FROM building.floor_facility_areas x
    WHERE x.floor_id = f.floor_id
) a ON true;

-- -----------------------------------------------------------------------------
-- 年度新增明細（對應 Excel 的「年度新增明細」工作表 / _annual_rows()）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_annual_growth AS
WITH per_year AS (
    SELECT
        COALESCE(f.expected_completion_year_num, 0) AS year_num,
        sum(f.floor_area_m2)                       AS added_area_m2,
        string_agg(DISTINCT b.building_code, '、' ORDER BY b.building_code) AS added_buildings
    FROM building.floors f
    JOIN building.buildings b ON b.building_id = f.building_id
    GROUP BY 1
), running AS (
    SELECT
        year_num,
        -- 與 _parse_year() 的標籤規則一致：無年份→現況、相對年→Y26、西元年→2026
        CASE
            WHEN year_num = 0    THEN '現況'
            WHEN year_num < 1000 THEN 'Y' || year_num
            ELSE year_num::text
        END AS year_label,
        added_buildings,
        added_area_m2,
        sum(added_area_m2) OVER (ORDER BY year_num ROWS UNBOUNDED PRECEDING) AS cumulative_area_m2
    FROM per_year
)
SELECT
    year_num,
    year_label,
    cumulative_area_m2 - added_area_m2 AS starting_area_m2,
    added_buildings,
    added_area_m2,
    0::numeric                         AS reduced_area_m2,
    cumulative_area_m2,
    CASE WHEN cumulative_area_m2 - added_area_m2 > 0
         THEN added_area_m2 / (cumulative_area_m2 - added_area_m2)
    END AS growth_rate
FROM running;

-- -----------------------------------------------------------------------------
-- 製程大群組面積彙總
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_process_group_area AS
SELECT
    COALESCE(g.group_name, '未分群') AS group_name,
    CASE WHEN btrim(f.process_name) = '' THEN '非製程' ELSE f.process_name END AS process_name,
    count(*)                         AS floor_count,
    sum(f.floor_area_m2)             AS floor_area_m2,
    sum(f.cleanroom_area_m2)         AS cleanroom_area_m2,
    sum(f.facility_area_m2)          AS facility_area_m2
FROM building.floors f
LEFT JOIN building.process_group_members m ON m.process_name = f.process_name
LEFT JOIN building.process_groups        g ON g.group_id = m.group_id
GROUP BY 1, 2;

-- -----------------------------------------------------------------------------
-- 需求趨勢（電力／用水）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_utility_trend AS
SELECT
    m.metric_key,
    m.metric_name,
    m.unit,
    p.year_key,
    p.year_label,
    p.value,
    p.is_baseline,
    -- 現況只是累積基準，不列入年增；累積值仍含現況
    sum(p.value) OVER (PARTITION BY m.metric_key ORDER BY p.sort_order, p.year_key
                       ROWS UNBOUNDED PRECEDING) AS cumulative_value,
    CASE WHEN p.is_baseline THEN 0 ELSE p.value END AS annual_value
FROM building.utility_metrics m
JOIN building.utility_metric_points p ON p.metric_key = m.metric_key;

-- -----------------------------------------------------------------------------
-- 異動紀錄（對應 Excel 的 change_log 工作表）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_change_log AS
SELECT
    c.change_id,
    c.changed_at,
    c.effective_date,
    c.change_type,
    c.changed_by,
    c.reason,
    c.source_reference,
    c.revision_before,
    c.revision_after,
    (c.summary ->> 'area_delta_m2')::numeric AS area_delta_m2,
    (c.summary ->> 'buildings_added')::int   AS buildings_added,
    (c.summary ->> 'buildings_removed')::int AS buildings_removed,
    (c.summary ->> 'buildings_updated')::int AS buildings_updated,
    (c.summary ->> 'floors_added')::int      AS floors_added,
    (c.summary ->> 'floors_removed')::int    AS floors_removed,
    (c.summary ->> 'floors_updated')::int    AS floors_updated
FROM building.data_change_log c;

-- -----------------------------------------------------------------------------
-- 欄位字典（給外部團隊查，不用來問我們欄位是什麼意思）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW building_api.v_data_dictionary AS
SELECT object_name, field_name, description, data_type, rule_or_unit
FROM building.data_dictionary
ORDER BY object_name, sort_order, field_name;

COMMIT;
