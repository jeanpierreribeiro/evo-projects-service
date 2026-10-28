-- =============================================================================
-- Inventário do Schema 'projects' - Módulo de Projetos (evo-projects-service)
-- Data: 2026-10-27
-- Etapa: E1.0-a (solicitacao-ajustes-projetos-v2.0.md)
-- =============================================================================

SET search_path TO projects, public;

-- 1. Contagens gerais de tabelas
SELECT '1. CONTAGEM GERAL DE ENTIDADES' AS secao;
SELECT 
    (SELECT COUNT(*) FROM workspaces) AS total_workspaces,
    (SELECT COUNT(*) FROM workspace_members) AS total_workspace_members,
    (SELECT COUNT(*) FROM projects) AS total_projects,
    (SELECT COUNT(*) FROM columns) AS total_columns,
    (SELECT COUNT(*) FROM tasks) AS total_tasks,
    (SELECT COUNT(*) FROM subtasks) AS total_subtasks,
    (SELECT COUNT(*) FROM task_relations) AS total_task_relations,
    (SELECT COUNT(*) FROM task_resources) AS total_task_resources,
    (SELECT COUNT(*) FROM comments) AS total_comments,
    (SELECT COUNT(*) FROM activities) AS total_activities,
    (SELECT COUNT(*) FROM notifications) AS total_notifications,
    (SELECT COUNT(*) FROM time_entries) AS total_time_entries,
    (SELECT COUNT(*) FROM custom_fields) AS total_custom_fields,
    (SELECT COUNT(*) FROM custom_field_values) AS total_custom_field_values;

-- 2. Status de Aprovação legado nas Tarefas
SELECT '2. STATUS DE APROVACAO LEGADO' AS secao;
SELECT "approvalStatus", COUNT(*) AS count
FROM tasks
GROUP BY "approvalStatus";

SELECT COUNT(*) AS tasks_with_approval_token
FROM tasks
WHERE "approvalToken" IS NOT NULL;

SELECT COUNT(*) AS tasks_with_approval_pin
FROM tasks
WHERE "approvalPin" IS NOT NULL;

-- 3. Identificadores de Usuário (quantos parecem e-mail vs UUID/ID)
SELECT '3. IDENTIFICADORES DE USUARIO (MEMBERS & TASKS)' AS secao;
SELECT 
    COUNT(*) AS total_members,
    COUNT(*) FILTER (WHERE "userId" LIKE '%@%') AS members_userId_is_email,
    COUNT(*) FILTER (WHERE "userId" NOT LIKE '%@%') AS members_userId_is_id
FROM workspace_members;

SELECT "userId", email, name, role
FROM workspace_members;

SELECT 
    COUNT(*) AS total_assigned_tasks,
    COUNT(*) FILTER (WHERE "assigneeId" LIKE '%@%') AS assignee_is_email,
    COUNT(*) FILTER (WHERE "assigneeId" NOT LIKE '%@%') AS assignee_is_id
FROM tasks
WHERE "assigneeId" IS NOT NULL;

-- 4. Distribuição de Horas Estimadas
SELECT '4. DISTRIBUICAO DE ESTIMATED_HOURS' AS secao;
SELECT 
    COUNT(*) AS total_tasks,
    COUNT(*) FILTER (WHERE "estimatedHours" IS NULL) AS hours_null,
    COUNT(*) FILTER (WHERE "estimatedHours" = 0) AS hours_zero,
    COUNT(*) FILTER (WHERE "estimatedHours" < 0) AS hours_negative,
    COUNT(*) FILTER (WHERE "estimatedHours" > 0 AND "estimatedHours" = FLOOR("estimatedHours")) AS hours_integer,
    COUNT(*) FILTER (WHERE "estimatedHours" > 0 AND "estimatedHours" != FLOOR("estimatedHours")) AS hours_fractional
FROM tasks;

-- 5. Amostras de datas (startDate, dueDate)
SELECT '5. AMOSTRAS DE DATAS (START_DATE, DUE_DATE)' AS secao;
SELECT id, "taskNumber", title, "startDate", "dueDate",
       TO_CHAR("startDate", 'YYYY-MM-DD HH24:MI:SS OF') AS start_date_formatted,
       TO_CHAR("dueDate", 'YYYY-MM-DD HH24:MI:SS OF') AS due_date_formatted
FROM tasks
WHERE "startDate" IS NOT NULL OR "dueDate" IS NOT NULL
LIMIT 10;

-- 6. Distribuição de tags
SELECT '6. DISTRIBUICAO DE TAGS' AS secao;
SELECT UNNEST(tags) AS tag, COUNT(*) AS count
FROM tasks
GROUP BY tag
ORDER BY count DESC;
