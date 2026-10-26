# evo-projects-service (jprOS + Kaneo Engine)

Microsserviço dedicado à **Gestão de Projetos, Multi-Workspace, Dashboard Central, Inbox, Gráfico de Gantt e Portal de Validação/Aprovação de Tarefas** para o ecossistema **jprOS**, inspirado na engine de regras e visualizações do **Kaneo**.

---

## 🚀 Características

- **Abordagem Headless**: Microsserviço limpo em Node.js 20, Fastify 5, Prisma 6 e TypeScript.
- **Multi-Workspace**: Isolamento total de projetos, quadros, tarefas, membros e permissões por empresa ou cliente atendido.
- **Banco Isolado**: Utiliza o PostgreSQL compartilhado do jprOS sob o schema dedicado `?schema=projects`.
- **Autenticação Integrada**: Suporte nativo aos tokens JWT do `evo-auth-service-community`.
- **Engine de Gantt Kaneo**: Cálculo determinístico de cronogramas e janelas temporais baseado em `date-fns`.
- **Portal de Validação com PIN**: Link seguro com token único e PIN de 4 dígitos para o cliente final aprovar entregas ou solicitar ajustes diretamente no navegador ou via WhatsApp sem necessidade de login.
- **Servidor MCP Embutido (`/api/v1/projects/mcp`)**: Ferramentas expostas via JSON e JSON-RPC 2.0 para consumo pelos agentes do `evo-ai-processor-community` e pelo robô WhatsApp (`evo-bot-runtime`).

---

## 🗄️ Modelos de Dados (Prisma)

- `Workspace`: Empresas/clientes atendidos no jprOS com isolamento de dados.
- `WorkspaceMember`: Membros do workspace com papéis (`ADMIN`, `MEMBER`, `VIEWER`).
- `Project`: Projetos pertencentes a um workspace.
- `Column`: Colunas do fluxo de trabalho com ordem configurável e indicação de coluna de conclusão.
- `Task`: Demandas e tarefas completas (número sequencial, título, markdown, prioridade, responsável, datas para Gantt, tags e campos de validação de entrega).
- `Subtask`: Checklist de subtarefas com cálculo de progresso `%`.
- `TaskRelation`: Relações de dependência (`BLOCKS`, `BLOCKED_BY`, `RELATES_TO`).
- `TaskResource`: Links externos para Figma, Google Drive, repositórios e documentações.
- `TimeEntry`: Registro de apontamento de horas gastas pelo operador.
- `Comment`: Comentários com menções e histórico.
- `Activity`: Log cronológico de auditoria do workspace.
- `Notification`: Central de notificações para o Inbox do operador.

---

## 🌐 Rotas da API REST

Prefixo: `/api/v1/projects`

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/health` | Healthcheck do microsserviço |
| `GET` | `/workspaces` | Lista workspaces do operador autenticado |
| `POST` | `/workspaces` | Cria novo workspace |
| `GET` | `/workspaces/:id` | Detalhes do workspace |
| `PUT` | `/workspaces/:id` | Atualiza dados do workspace |
| `DELETE` | `/workspaces/:id` | Exclui workspace |
| `GET` | `/workspaces/:id/members` | Lista membros do workspace |
| `POST` | `/workspaces/:id/members` | Adiciona/convida membro |
| `DELETE` | `/workspaces/:id/members/:memberId` | Remove membro |
| `GET` | `/workspaces/:workspaceId/dashboard` | Indicadores, Up next, progresso e atividades |
| `GET` | `/workspaces/:workspaceId/inbox` | Central de notificações |
| `PATCH` | `/inbox/:id/read` | Marca notificação como lida |
| `POST` | `/workspaces/:workspaceId/inbox/mark-all-read` | Marca todas as notificações como lidas |
| `GET` | `/workspaces/:workspaceId/my-tasks` | Tarefas atribuídas ao operador no workspace |
| `GET` | `/workspaces/:workspaceId/projects` | Lista projetos do workspace |
| `POST` | `/workspaces/:workspaceId/projects` | Cria projeto com colunas padrão |
| `GET` | `/projects/:id` | Detalhes do projeto com colunas e etiquetas |
| `PUT` | `/projects/:id` | Atualiza projeto |
| `DELETE` | `/projects/:id` | Remove projeto |
| `GET` | `/projects/:projectId/columns` | Lista colunas do projeto |
| `POST` | `/projects/:projectId/columns` | Cria nova coluna |
| `PUT` | `/columns/:id` | Atualiza coluna |
| `PUT` | `/projects/:projectId/columns/reorder` | Reordena colunas |
| `DELETE` | `/columns/:id` | Remove coluna |
| `GET` | `/projects/:projectId/tasks` | Lista tarefas do projeto |
| `POST` | `/projects/:projectId/tasks` | Cria tarefa |
| `GET` | `/tasks/:id` | Detalhes completos da tarefa |
| `PUT` | `/tasks/:id` | Atualiza campos da tarefa |
| `PUT` | `/tasks/:id/move` | Move tarefa entre colunas e posições (drag & drop) |
| `DELETE` | `/tasks/:id` | Remove tarefa |
| `POST` | `/tasks/:id/approval/generate` | Gera token seguro e código PIN de validação |
| `GET` | `/public/tasks/:token/preview` | Resumo público pré-PIN |
| `POST` | `/public/tasks/:token/validate-pin` | Valida PIN e libera dados completos da entrega |
| `POST` | `/public/tasks/:token/approve` | Cliente aprova a entrega (grava IP/data e move p/ Concluído) |
| `POST` | `/public/tasks/:token/request-changes` | Cliente solicita ajustes com feedback |

---

## 🤖 Ferramentas MCP (Model Context Protocol)

Endpoints:
- `GET /api/v1/projects/mcp/tools` (manifesto)
- `POST /api/v1/projects/mcp/call` (execução REST)
- `POST /api/v1/projects/mcp` (JSON-RPC 2.0)

Ferramentas disponíveis:
1. `list_workspaces`
2. `list_projects`
3. `list_tasks`
4. `get_task`
5. `create_task`
6. `update_task`
7. `request_task_approval`

---

## 🛠️ Comandos de Desenvolvimento

```bash
# Instalar dependências
pnpm install

# Gerar cliente Prisma
npx prisma generate

# Executar migração / push de schema
npx prisma db push

# Compilar TypeScript
pnpm run build

# Executar em desenvolvimento
pnpm run dev
```
