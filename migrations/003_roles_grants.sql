-- =============================================================================
-- 003_roles_grants.sql — 角色與授權
--
-- ⚠ 這一檔需要 CREATEROLE 權限，通常要請 DBA 執行。
--    一般的 migration（001/002）用 building_mgmt_migrate 帳號跑就夠，
--    由 run-migrations.ps1 帶 -SkipRoles 略過本檔。
--
-- 這裡只建「群組角色」（NOLOGIN、無密碼），不建實際登入帳號 ——
-- 登入帳號與密碼由 DBA 依公司規範建立後，再 GRANT 進對應群組：
--
--    CREATE USER building_mgmt_svc LOGIN PASSWORD '<由 DBA 產生>' IN ROLE building_mgmt_app;
--    CREATE USER bi_reader         LOGIN PASSWORD '<由 DBA 產生>' IN ROLE building_mgmt_reader;
--
-- 角色名稱都帶 building_mgmt_ 前綴，是因為 PostgreSQL 的角色是**整個 cluster 共用**的，
-- 在共用資料庫主機上撞名的風險比 schema 還高。
--
-- 權限分界：
--    building_mgmt_migrate  只在跑 migration 時使用，擁有 schema 與物件（DDL）
--    building_mgmt_app      應用程式日常使用，只有 DML，不能改結構
--    building_mgmt_reader   外部 BI / 報表，只看得到 v_ 開頭的 view
--
-- 本檔可重複執行（idempotent）。
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_mgmt_migrate') THEN
        CREATE ROLE building_mgmt_migrate NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_mgmt_app') THEN
        CREATE ROLE building_mgmt_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_mgmt_reader') THEN
        CREATE ROLE building_mgmt_reader NOLOGIN;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- building_mgmt_migrate：schema 與物件的擁有者
-- -----------------------------------------------------------------------------
ALTER SCHEMA building_mgmt OWNER TO building_mgmt_migrate;

-- -----------------------------------------------------------------------------
-- building_mgmt_app：只有 DML，不能改結構
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA building_mgmt TO building_mgmt_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA building_mgmt TO building_mgmt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA building_mgmt TO building_mgmt_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA building_mgmt TO building_mgmt_app;

-- 之後 migration 新增的物件自動比照辦理，不用每次補 GRANT
ALTER DEFAULT PRIVILEGES FOR ROLE building_mgmt_migrate IN SCHEMA building_mgmt
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO building_mgmt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE building_mgmt_migrate IN SCHEMA building_mgmt
    GRANT USAGE, SELECT ON SEQUENCES TO building_mgmt_app;

-- -----------------------------------------------------------------------------
-- building_mgmt_reader：外部 BI 唯讀
--
-- 表與 view 放在同一個 schema，所以不能像分開兩個 schema 時那樣靠
-- 「不給 USAGE」來隔離 —— 這裡改成逐一授權 v_ 開頭的 view，
-- 內部表一個都不給。ALTER DEFAULT PRIVILEGES 無法區分 view 與 table，
-- 因此刻意不用，改為列舉；日後新增 view 時要記得補進這份清單。
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA building_mgmt TO building_mgmt_reader;

GRANT SELECT ON building_mgmt.v_building_master    TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_floor_area_detail  TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_annual_growth      TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_process_group_area TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_utility_trend      TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_change_log         TO building_mgmt_reader;
GRANT SELECT ON building_mgmt.v_data_dictionary    TO building_mgmt_reader;

-- 防呆：確認沒有把內部表也一起開出去。
-- 有任何非 v_ 開頭的物件被授權給 reader 就直接讓 migration 失敗。
DO $$
DECLARE
    leaked text;
BEGIN
    SELECT string_agg(table_name, '、')
      INTO leaked
      FROM information_schema.role_table_grants
     WHERE grantee = 'building_mgmt_reader'
       AND table_schema = 'building_mgmt'
       AND table_name NOT LIKE 'v\_%';
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION '外部唯讀角色被授權到內部表：%。請檢查授權設定。', leaked;
    END IF;
END $$;

-- 防呆：確保 PUBLIC 沒有殘留權限
REVOKE ALL ON SCHEMA building_mgmt FROM PUBLIC;

COMMIT;
