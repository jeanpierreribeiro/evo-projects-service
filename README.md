# evo-projects-service (jprOS Projects Submodule)

Microsserviço de **Gestão de Projetos, Multi-Workspace, Dashboard Central, Notificações Privadas (Inbox), Visões Operacionais (Kanban, Lista, Gantt, Calendário e Backlog), Anexos Seguros, Campos Personalizados, Apontamentos de Horas e Compartilhamento de Leitura por PIN** para o ecossistema **jprOS**.

---

## 🚀 Características Principais

- **Arquitetura Headless**: Microsserviço autônomo em Node.js 20, Fastify 5, Prisma 6 e TypeScript, operando como motor de regras de negócio consumido pelo `evo-ai-frontend-community` e integrações autorizadas.
- **Isolamento Multi-Workspace Estrito**: Segregação completa de dados por empresa cliente (`workspaceId`). Cada workspace possui seus próprios membros, projetos, colunas, tarefas e registros de auditoria, validados via `AccessService`.
- **Banco de Dados e Migrações Versionadas**: PostgreSQL sob schema dedicado `projects` (`?schema=projects`). Migrações gerenciadas estritamente com `prisma migrate deploy` (usuário DDL `projects_migrator` e runtime DML `projects_app`), sem uso de `db push` em ambientes de homologação ou produção.
- **Autenticação e Projeção de Usuários**: Integração nativa com tokens JWT emitidos pelo `evo-auth-service-community`. Manutenção de tabela de projeção de usuários (`UserProjection`) para auditoria imutável mesmo se o cadastro de origem for alterado.
- **Controle de Concorrência Otimista (OCC)**: Versionamento monotônico de tarefas (`version`). Updates concorrentes que fornecem `expectedVersion` desatualizado são rejeitados com `409 Conflict` (`VERSION_CONFLICT`), prevenindo sobreescritas acidentais.
- **Anexos Seguros com Armazenamento Local (E3.7 / T10)**:
  - Upload multipart/form-data com limite de 20 MiB validado na aplicação e no Nginx Gateway (`25M`).
  - Proteção ativa contra arquivos executáveis, spoofing de extensão e injeções poliglotas (`<script`, `<html`, `<svg`, `javascript:`, `onerror=`) nos primeiros 8 KB.
  - Hashing criptográfico SHA-256 e sanitização de nomes de arquivos.
  - Isolamento estrito de confidencialidade: anexos vinculados a comentários (`commentId !== null`) são estritamente internos e nunca podem ser expostos em links públicos.
- **Campos Personalizados do Projeto (E3.8 / T14)**:
  - Tipos suportados: `text`, `number`, `date` (calendário civil YYYY-MM-DD com validação) e `select` (com IDs de opções estáveis `opt_<hash>`).
  - Flag `isPublicEligible Boolean` gerenciada exclusivamente por `ADMIN`.
  - Invariante de isolamento I8: campos só podem ser associados a tarefas do mesmo projeto.
- **Apontamentos de Horas (`TimeEntry` - E3.8-c / T04 / T13)**:
  - Autoria estrita (T04): apenas o operador que registrou o apontamento ou administradores (`ADMIN`) podem editar ou remover suas horas (`403 Forbidden` com código `NOT_RESOURCE_AUTHOR`).
  - Somatória automática de minutos e conversão para horas decimais com arredondamento preciso.
- **Compartilhamento de Leitura com Cliente (Fase 2 / E3.7 / E3.8)**:
  - Emissão de links de leitura protegidos por PIN de 6 dígitos (`crypto.randomInt(100000, 999999)`), com token criptográfico de uso único por sessão de cliente (`crypto.randomBytes(32)`).
  - Seleção granular de seções, anexos autorizados (não-comentários) e campos personalizados elegíveis.
  - Proteção contra força bruta: lockout após 5 tentativas incorretas com contador de falhas.
  - Revogação imediata em cascata ao expirar, revogar, arquivar a tarefa ou transferir de projeto.
- **Visões Operacionais de Alta Fidelidade (E3.10)**:
  - **Kanban**: Reordenação de colunas integrada para administradores.
  - **Lista**: Busca textual, filtros avançados (Coluna, Prioridade, Responsável) e ordenação estável por todas as colunas.
  - **Gráfico de Gantt**: Invariante de fidelidade temporal (DP11/U0) sem síntese de datas fictícias; tarefas completas, prazos pontuais (milestones) e detecção bidirecional de conflitos de cronograma.
  - **Calendário**: Gaveta dedicada para tarefas ativas sem prazo de entrega.
  - **Backlog**: Triagem ágil baseada na coluna configurada em `project.backlogColumnId`.
  - **Rota Canônica**: `/projects/tasks/:taskId` suportando abertura direta e compartilhamento interno seguro.
- **Servidor MCP Homologado (`POST /mcp` e `/api/v1/projects/mcp`)**: Streamable HTTP JSON-RPC 2.0 padrão (revisão 2024-11-05), com handshake `initialize`, controle estrito de Origin contra CSRF/DNS rebinding, rate limit por credencial e ator (120 req/min), limite de concorrência, filtragem de ferramentas por grant e 3 modos de ator (`operator_assist`, `autonomous`, `customer_agent`).
- **Integração CRM Determinística (DP14)**: Resolução determinística de contexto de atendimento (`src/crm/resolve.ts`) baseada em conversa ativa, contato único ou rota exclusiva de inbox. Ambiguidade ou ausência NUNCA escreve. DTO de atendimento (`TaskCustomerAgentDTO`) isola dados internos de clientes.

---

## 🗄️ Modelos de Dados (Prisma Schema)

| Modelo | Finalidade Principal |
|---|---|
| `Workspace` | Empresa ou cliente com isolamento rigoroso de projetos e tarefas |
| `WorkspaceMember` | Vínculo de membro no workspace (`ADMIN`, `MEMBER`, `VIEWER`) com status de reconciliação |
| `UserProjection` | Projeção resiliente de dados de usuário autenticado no Auth Service |
| `ServicePrincipal` & `ServiceCredential` | Identidades de serviço para integrações e agentes com tokens `sp_*` criptografados em SHA-256 |
| `IntegrationGrant` | Concessões explícitas de acesso por workspace/projeto |
| `Project` | Agrupador de fluxo de trabalho, com colunas, prefixo de código semântico e backlogColumnId |
| `Column` | Colunas do fluxo Kanban com ordem e flag `isDoneColumn` |
| `Task` | Registro central da tarefa (versão monotônica, datas, prioridade, responsável, aprovação) |
| `Subtask` | Checklist com progresso percentual independente |
| `TaskRelation` | Relações de dependência (`BLOCKS`, `BLOCKED_BY`, `RELATES_TO`) com validação de ciclos |
| `TaskResource` | Links externos (Figma, Drive, repositórios) |
| `TaskAttachment` | Anexos de tarefas com SHA-256, tamanho, mime-type e download autenticado |
| `CustomField` | Campos customizados por projeto (`text`, `number`, `date`, `select`) e `isPublicEligible` |
| `TaskCustomFieldValue` | Valores dos campos customizados preenchidos na tarefa |
| `TimeEntry` | Apontamentos de horas com autoria estrita (T04) |
| `WorkspaceContactLink` | Vínculos de contatos CRM a workspaces específicos (multiempresa) |
| `WorkspaceInboxRoute` | Rotas de fallback por caixa de entrada/canal CRM (somente se exclusiva) |
| `ConversationProjectContext` | Vínculo explícito e temporário de uma conversa CRM a projeto/workspace |
| `TaskCrmLink` | Vínculo da tarefa a contato e conversa do CRM para isolamento de visibilidade |
| `Comment` | Comentários internos da equipe |
| `TaskShare` & `TaskShareAttachment` & `TaskShareCustomField` | Links de visualização por PIN com expiração, revogação e seleções granulares |
| `Activity` | Log de auditoria interna imutável |
| `Notification` | Central de notificações privadas (Inbox) com deduplicação e arquivamento |

---

## 🌐 Inventário de Rotas REST

Prefixo padrão: `/api/v1/projects` (disponibilizado via Nginx na porta `3030` em produção ou `3013` em desenvolvimento local).

### Workspaces e Membros
- `GET /workspaces`: Lista workspaces onde o operador é membro ativo
- `POST /workspaces`: Criação de novo workspace
- `GET /workspaces/:id`: Detalhes do workspace
- `PUT /workspaces/:id`: Atualização de configurações (`ADMIN`)
- `DELETE /workspaces/:id`: Exclusão de workspace (`ADMIN`)
- `GET /workspaces/:id/members`: Lista membros do workspace
- `POST /workspaces/:id/members`: Adiciona novo membro validado contra o Auth (`ADMIN`)
- `DELETE /workspaces/:id/members/:memberId`: Remove membro (`ADMIN`, impede remoção do último ADMIN)
- `GET /workspaces/:workspaceId/dashboard`: Métricas agregadas, tarefas próximas e atividades
- `GET /workspaces/:workspaceId/inbox`: Notificações privadas (suporta `unreadOnly=true`, `archived=true`)
- `PATCH /inbox/:id/read`: Marca notificação como lida
- `PATCH /inbox/:id/archive`: Arquiva notificação
- `PATCH /inbox/:id/unarchive`: Desarquiva notificação
- `POST /workspaces/:workspaceId/inbox/mark-all-read`: Marca todas as notificações como lidas
- `GET /workspaces/:workspaceId/my-tasks`: Tarefas atribuídas ao operador autenticado

### Projetos e Colunas
- `GET /workspaces/:workspaceId/projects`: Lista projetos do workspace (suporta `includeArchived=true`)
- `POST /workspaces/:workspaceId/projects`: Cria projeto com colunas padrão e chave de código
- `GET /projects/:id`: Detalhes do projeto com colunas e campos personalizados
- `PUT /projects/:id`: Atualização de dados do projeto (nome, descrição, cor, backlogColumnId)
- `DELETE /projects/:id`: Exclusão definitiva do projeto (`ADMIN`)
- `POST /projects/:id/archive`: Arquivamento do projeto
- `POST /projects/:id/unarchive`: Desarquivamento do projeto
- `GET /projects/:projectId/columns`: Lista colunas do projeto
- `POST /projects/:projectId/columns`: Cria nova coluna
- `PUT /columns/:id`: Atualiza coluna (nome, cor, isDoneColumn)
- `PUT /projects/:projectId/columns/reorder`: Reordenação de colunas em lote (`ADMIN`)
- `DELETE /columns/:id`: Exclui coluna com opção de migração de tarefas para outra coluna

### Tarefas e Relações
- `GET /projects/:projectId/tasks`: Lista tarefas ativas com filtros
- `POST /projects/:projectId/tasks`: Cria nova tarefa com incremento sequencial
- `GET /tasks/:id`: Busca autorizada de tarefa interna via `TaskInternalDTO`
- `PATCH /tasks/:id`: Atualização parcial com controle otimista (`expectedVersion`)
- `PUT /tasks/:id/move`: Movimentação de tarefa entre colunas e posições
- `DELETE /tasks/:id`: Exclusão de tarefa
- `POST /tasks/:id/archive`: Arquiva tarefa
- `POST /tasks/:id/unarchive`: Desarquiva tarefa
- `POST /tasks/:id/transfer/preview`: Prévia de impacto de transferência entre projetos
- `POST /tasks/:id/transfer`: Execução transacional de transferência entre projetos
- `POST /tasks/:taskId/subtasks`: Adiciona subtarefa
- `PUT /subtasks/:id`: Atualiza subtarefa (título, concluída, posição)
- `DELETE /subtasks/:id`: Remove subtarefa
- `POST /tasks/:taskId/relations`: Adiciona relação com validação anti-ciclo (`BLOCKS`, `BLOCKED_BY`, `RELATES_TO`)
- `DELETE /relations/:id`: Remove relação

### Anexos e Armazenamento
- `GET /tasks/:taskId/attachments`: Lista anexos da tarefa com metadados e tamanho
- `POST /tasks/:taskId/attachments`: Upload de arquivo multipart/form-data até 20 MiB
- `DELETE /attachments/:id`: Remove anexo
- `GET /attachments/:id/download`: Download seguro autenticado com cabeçalhos de segurança CSP/nosniff

### Campos Personalizados e Tempo
- `GET /projects/:projectId/custom-fields`: Lista campos personalizados do projeto
- `POST /projects/:projectId/custom-fields`: Cria campo personalizado (`ADMIN`)
- `PATCH /custom-fields/:id`: Atualiza opções ou elegibilidade pública (`ADMIN`)
- `DELETE /custom-fields/:id`: Remove campo personalizado (`ADMIN`)
- `GET /tasks/:taskId/custom-field-values`: Consulta valores de campos da tarefa
- `PUT /tasks/:taskId/custom-field-values`: Grava valores de campos da tarefa com validação estrita
- `GET /tasks/:taskId/time-entries`: Lista apontamentos com somatória agregada em minutos e horas
- `POST /tasks/:taskId/time-entries`: Adiciona apontamento com data civil e nota
- `PATCH /time-entries/:id`: Atualiza apontamento (autoria restrita T04)
- `DELETE /time-entries/:id`: Remove apontamento (autoria restrita T04)

### Compartilhamento Público com Cliente (PIN)
- `POST /tasks/:taskId/shares/preview`: Prévia do card público com seleções de anexos e campos
- `POST /tasks/:taskId/shares`: Emite link público com PIN de 6 dígitos
- `GET /tasks/:taskId/shares`: Lista links de compartilhamento da tarefa
- `PATCH /shares/:shareId`: Altera seleções ou prorroga expiração do link
- `POST /shares/:shareId/revoke`: Revoga o link imediatamente
- `POST /shares/:shareId/reissue`: Reemite o link com novo token e novo PIN
- `POST /public/shares/:token/unlock`: Valida PIN de 6 dígitos com proteção contra força bruta
- `GET /public/shares/:token/card`: Recupera card público sanitizado para o cliente
- `GET /public/shares/:token/attachments/:attachmentId`: Download público de anexo explicitamente selecionado
- `POST /public/shares/:token/logout`: Encerra a sessão pública do cliente

### CRM & Integrações Administrativas (E4.1 / E4.2)
- `GET /workspaces/:workspaceId/crm/contact-links`: Lista vínculos de contatos CRM com o workspace (`ADMIN`)
- `POST /workspaces/:workspaceId/crm/contact-links`: Cria vínculo de contato com o workspace (`ADMIN`)
- `DELETE /workspaces/:workspaceId/crm/contact-links/:id`: Remove vínculo de contato (`ADMIN`)
- `GET /workspaces/:workspaceId/crm/inbox-routes`: Lista rotas de inbox/canal (`ADMIN`)
- `POST /workspaces/:workspaceId/crm/inbox-routes`: Configura rota de inbox com flag de exclusividade (`ADMIN`)
- `DELETE /workspaces/:workspaceId/crm/inbox-routes/:id`: Remove rota de inbox (`ADMIN`)
- `GET /workspaces/:workspaceId/crm/conversation-contexts`: Lista contextos ativos de conversa (`ADMIN`)
- `POST /workspaces/:workspaceId/crm/conversation-contexts`: Fixa projeto para conversa com expiração (`ADMIN`)
- `DELETE /workspaces/:workspaceId/crm/conversation-contexts/:id`: Remove contexto de conversa (`ADMIN`)
- `GET /workspaces/:workspaceId/crm/diagnostics`: Diagnóstico administrativo de ambiguidades e destinos CRM (`ADMIN`)

### Protocolo MCP (Model Context Protocol - E4.3 / E4.4)
- `POST /mcp` (e `/api/v1/projects/mcp`): Endpoint Streamable HTTP JSON-RPC 2.0 padrão (revisão 2024-11-05).
  - Suporta métodos `initialize`, `notifications/initialized`, `tools/list` e `tools/call`.
  - Rate limiting (120 req/min), limite de concorrência e validação estrita de cabeçalho `Origin`.
  - Ferramentas: `list_workspaces`, `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`, `create_task_share`, `resolve_workspace`.
- `GET /mcp/tools`: Endpoint legado (retorna cabeçalho `X-Deprecated`).
- `POST /mcp/call`: Endpoint legado (retorna cabeçalho `X-Deprecated`).

---

## 🛠️ Comandos de Desenvolvimento e Homologação

```bash
# Instalar dependências
pnpm install

# Gerar tipos do cliente Prisma
npx prisma generate

# Verificar integridade e status das migrações (13 migrações ativas)
npx prisma migrate status

# Executar suíte completa de testes (26 arquivos, 193 testes 100% verdes)
npm test

# Executar suíte com observabilidade de tipos
npx tsc --noEmit

# Iniciar servidor em desenvolvimento
pnpm run dev
```
