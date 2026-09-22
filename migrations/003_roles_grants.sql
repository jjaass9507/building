-- =============================================================================
-- 003_roles_grants.sql — 角色與授權
--
-- ⚠ 這一檔需要 CREATEROLE 權限，通常要請 DBA 執行。
--    日常的 migration（001/002）用 svc_building_mgmt_migrator 跑就夠，
--    由 run-migrations.ps1 帶 -SkipRoles 略過本檔。
--
-- === 兩個服務帳號 ===
--    svc_building_mgmt_migrator  跑 migration 用，擁有 schema 與物件（DDL）
--    svc_building_mgmt_rw        應用程式日常使用，只有 DML，不能改結構
--
-- 本檔**只負責授權**，不設定密碼 —— 密碼不能進版控。
-- 帳號若不存在，這裡會先建成 NOLOGIN 佔位，讓授權可以套用；
-- 實際的密碼與登入權限請用互動式腳本設定（密碼不落檔案、不進指令歷史）：
--
--     .\scripts\create-db-users.ps1
--
-- 也可以請 DBA 自行執行：
--     ALTER ROLE svc_building_mgmt_rw       LOGIN PASSWORD '<由 DBA 產生>';
--     ALTER ROLE svc_building_mgmt_migrator LOGIN PASSWORD '<由 DBA 產生>';
--
-- 帳號已經存在時本檔不會動它的密碼或 LOGIN 屬性，可以安全重跑。
--
-- === 外部 BI ===
--    building_mgmt_reader 是 NOLOGIN 的群組角色，不是實際帳號。
--    BI 的登入帳號由 DBA 建立後 GRANT 進這個群組：
--        CREATE USER <bi 帳號> LOGIN PASSWORD '<由 DBA 產生>' IN ROLE building_mgmt_reader;
--    這樣多個 BI 帳號共用同一套授權，新增帳號不必再動 migration。
--
-- 名稱都帶 building_mgmt 字樣，是因為 PostgreSQL 的角色**整個 cluster 共用**，
-- 在共用資料庫主機上撞名的風險比 schema 還高。
--
-- 本檔可重複執行（idempotent）。
-- =============================================================================

BEGIN;

DO $$
BEGIN
    -- 服務帳號：只在不存在時建立成 NOLOGIN 佔位，已存在就完全不動
    -- （避免重跑 migration 時把 DBA 設好的密碼或 LOGIN 屬性洗掉）
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_building_mgmt_migrator') THEN
        CREATE ROLE svc_building_mgmt_migrator NOLOGIN;
        RAISE NOTICE '已建立 svc_building_mgmt_migrator（NOLOGIN）。請用 scripts\create-db-users.ps1 設定密碼。';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_building_mgmt_rw') THEN
        CREATE ROLE svc_building_mgmt_rw NOLOGIN;
        RAISE NOTICE '已建立 svc_building_mgmt_rw（NOLOGIN）。請用 scripts\create-db-users.ps1 設定密碼。';
    END IF;

    -- 外部 BI 用的群組角色（不是登入帳號）
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'building_mgmt_reader') THEN
        CREATE ROLE building_mgmt_reader NOLOGIN;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- svc_building_mgmt_migrator：schema 與物件的擁有者
--
-- ALTER SCHEMA 只改 schema 本身的擁有權，不會動既有的表。
-- 若 001/002 是由 DBA 的管理帳號先跑的（很常見），那些物件就歸管理帳號所有，
-- migrator 之後連 schema_migrations 都寫不進去。這裡把擁有權整批歸位，
-- 不論先前是誰跑的都能收斂到同一個結果。
-- -----------------------------------------------------------------------------
ALTER SCHEMA building_mgmt OWNER TO svc_building_mgmt_migrator;

DO $$
DECLARE
    target CONSTANT text := 'svc_building_mgmt_migrator';
    obj    record;
BEGIN
    -- 表、分割表、view、序列
    --
    -- identity / serial 的序列不能單獨改擁有者（PostgreSQL 會擋下來，
    -- 說它 linked to table）—— 那種序列的擁有權跟著母表走，
    -- ALTER TABLE OWNER 就會一併處理，所以這裡要排除掉。
    FOR obj IN
        SELECT c.relkind, c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'building_mgmt'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
           AND c.relowner <> target::regrole
           AND NOT (
               c.relkind = 'S'
               AND EXISTS (
                   SELECT 1 FROM pg_depend d
                    WHERE d.objid = c.oid
                      AND d.classid = 'pg_class'::regclass
                      AND d.deptype IN ('a', 'i')
               )
           )
    LOOP
        CASE obj.relkind
            WHEN 'r', 'p' THEN
                EXECUTE format('ALTER TABLE building_mgmt.%I OWNER TO %I', obj.relname, target);
            WHEN 'v' THEN
                EXECUTE format('ALTER VIEW building_mgmt.%I OWNER TO %I', obj.relname, target);
            WHEN 'm' THEN
                EXECUTE format('ALTER MATERIALIZED VIEW building_mgmt.%I OWNER TO %I', obj.relname, target);
            WHEN 'S' THEN
                EXECUTE format('ALTER SEQUENCE building_mgmt.%I OWNER TO %I', obj.relname, target);
        END CASE;
    END LOOP;

    -- 自訂型別（floor_status、user_role）
    FOR obj IN
        SELECT t.typname
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'building_mgmt'
           AND t.typtype = 'e'
           AND t.typowner <> target::regrole
    LOOP
        EXECUTE format('ALTER TYPE building_mgmt.%I OWNER TO %I', obj.typname, target);
    END LOOP;

    -- 函式（ensure_access_log_partition）
    FOR obj IN
        SELECT p.oid::regprocedure AS signature
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'building_mgmt'
           AND p.proowner <> target::regrole
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I', obj.signature, target);
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- svc_building_mgmt_rw：只有 DML，不能改結構
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA building_mgmt TO svc_building_mgmt_rw;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA building_mgmt TO svc_building_mgmt_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA building_mgmt TO svc_building_mgmt_rw;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA building_mgmt TO svc_building_mgmt_rw;

-- 之後 migration 新增的物件自動比照辦理，不用每次補 GRANT
ALTER DEFAULT PRIVILEGES FOR ROLE svc_building_mgmt_migrator IN SCHEMA building_mgmt
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO svc_building_mgmt_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_building_mgmt_migrator IN SCHEMA building_mgmt
    GRANT USAGE, SELECT ON SEQUENCES TO svc_building_mgmt_rw;

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
    SELECT string_agg(DISTINCT table_name, '、')
      INTO leaked
      FROM information_schema.role_table_grants
     WHERE grantee = 'building_mgmt_reader'
       AND table_schema = 'building_mgmt'
       AND table_name NOT LIKE 'v\_%';
    IF leaked IS NOT NULL THEN
        RAISE EXCEPTION '外部唯讀角色被授權到內部表：%。請檢查授權設定。', leaked;
    END IF;
END $$;

-- 防呆：提醒還沒設定密碼的服務帳號
DO $$
DECLARE
    pending text;
BEGIN
    SELECT string_agg(rolname, '、')
      INTO pending
      FROM pg_roles
     WHERE rolname IN ('svc_building_mgmt_rw', 'svc_building_mgmt_migrator')
       AND NOT rolcanlogin;
    IF pending IS NOT NULL THEN
        RAISE WARNING '下列服務帳號尚未啟用登入：%。請執行 scripts\create-db-users.ps1 設定密碼。', pending;
    END IF;
END $$;

-- 防呆：確保 PUBLIC 沒有殘留權限
REVOKE ALL ON SCHEMA building_mgmt FROM PUBLIC;

COMMIT;
