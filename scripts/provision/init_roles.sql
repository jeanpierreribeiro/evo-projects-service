-- =============================================================================
-- Provisionamento de Papéis do PostgreSQL para evo-projects-service
-- Etapa: E1.1-c (Fase 1 - solicitacao-ajustes-projetos-v2.0.md)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'projects_migrator') THEN
    CREATE ROLE projects_migrator WITH LOGIN PASSWORD 'projects_migrator_dev_password';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'projects_app') THEN
    CREATE ROLE projects_app WITH LOGIN PASSWORD 'projects_app_dev_password';
  END IF;
END $$;

-- Permissões do migrator (DDL completo em schema projects)
GRANT USAGE, CREATE ON SCHEMA projects TO projects_migrator;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA projects TO projects_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA projects TO projects_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA projects GRANT ALL ON TABLES TO projects_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA projects GRANT ALL ON SEQUENCES TO projects_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE projects_migrator IN SCHEMA projects GRANT ALL ON TABLES TO projects_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE projects_migrator IN SCHEMA projects GRANT ALL ON SEQUENCES TO projects_migrator;

-- Permissões do app (DML estrito, sem DDL)
GRANT USAGE ON SCHEMA projects TO projects_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA projects TO projects_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA projects TO projects_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA projects GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO projects_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA projects GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO projects_app;
ALTER DEFAULT PRIVILEGES FOR ROLE projects_migrator IN SCHEMA projects GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO projects_app;
ALTER DEFAULT PRIVILEGES FOR ROLE projects_migrator IN SCHEMA projects GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO projects_app;

-- Revogar explicitamente privilégios de projects_app sobre outros schemas
REVOKE ALL ON SCHEMA public FROM projects_app;
