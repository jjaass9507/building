-- =============================================================================
-- 003_roles_grants.sql — 角色與授權
--
-- ⚠ 這一檔需要 CREATEROLE 權限，通常要請 DBA 執行，
--    或由 run-migrations.ps1 帶 -AdminUser 參數以管理帳號執行。
--    一般的 migration（001/002）用 building_migrate 帳號跑就夠。
--
-- 這裡只建「群組角色」（NOLOGIN、無密碼），不建實際登入帳號 ——
-- 登入帳號與密碼由 DBA 依公司規範建立後，再 GRANT 進對應群組：
--
--    CREATE USER building_app_svc LOGIN PASSWORD '<由 DBA 產生>' IN ROLE building_app;
--    CREATE USER bi_reader        LOGIN PASSWORD '<由 DBA 產生>' IN ROLE building_reader;
--
-- 權限分界：
--    building_migrate  只在跑 migration 時使用，擁有 schema 與物件（DDL）
--    building_app      應用程式日常使用，只有 DML，不能改結構
--    building_reader   外部 BI / 報表，只看得到 building_api 的 view
--
-- 本檔可重複執行（idempotent）。
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_migrate') THEN
        CREATE ROLE building_migrate NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_app') THEN
        CREATE ROLE building_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_reader') THEN
        CREATE ROLE building_reader NOLOGIN;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- building_migrate：schema 與物件的擁有者
-- -----------------------------------------------------------------------------
ALTER SCHEMA building     OWNER TO building_migrate;
ALTER SCHEMA building_api OWNER TO building_migrate;

-- -----------------------------------------------------------------------------
-- building_app：只有 DML
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA building TO building_app;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA building TO building_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA building TO building_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA building TO building_app;

-- 應用程式自己也會用到對外 view（例如匯出報表時查欄位字典）
GRANT USAGE ON SCHEMA building_api TO building_app;
GRANT SELECT ON ALL TABLES IN SCHEMA building_api TO building_app;

-- 之後 migration 新增的物件自動比照辦理，不用每次補 GRANT
ALTER DEFAULT PRIVILEGES FOR ROLE building_migrate IN SCHEMA building
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO building_app;
ALTER DEFAULT PRIVILEGES FOR ROLE building_migrate IN SCHEMA building
    GRANT USAGE, SELECT ON SEQUENCES TO building_app;
ALTER DEFAULT PRIVILEGES FOR ROLE building_migrate IN SCHEMA building_api
    GRANT SELECT ON TABLES TO building_app;

-- -----------------------------------------------------------------------------
-- building_reader：外部唯讀，只看得到 view 層
--
-- 刻意「不」給 building schema 的 USAGE —— 外部連進來連內部表都看不到，
-- 這樣內部表怎麼改都不會打壞外部的報表。
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA building_api TO building_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA building_api TO building_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE building_migrate IN SCHEMA building_api
    GRANT SELECT ON TABLES TO building_reader;

-- 防呆：確保 PUBLIC 沒有殘留權限
REVOKE ALL ON SCHEMA building     FROM PUBLIC;
REVOKE ALL ON SCHEMA building_api FROM PUBLIC;

COMMIT;
