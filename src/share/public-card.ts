import { TaskPublicDTO } from '../dto/task-dto.js';
import { formatCivilDate } from '../utils/dates.js';

export interface BuildPublicCardOptions {
  showDescription?: boolean;
  showSubtasks?: boolean;
  showResources?: boolean;
  showAttachments?: boolean;
  showCustomFields?: boolean;
  selectedResourceIds?: string[];
  selectedAttachmentIds?: string[];
  selectedCustomFieldIds?: string[];
  shareToken?: string;
  publicContentUpdatedAt?: Date | string | null;
}

/**
 * Sanitiza Markdown e reescreve URLs de imagens embutidas (E3.7-d / T10).
 * - Remove tags e atributos executáveis (<script>, <iframe>, <svg>, onerror, javascript:).
 * - Imagens referenciando anexos da tarefa são reescritas para o endpoint do share caso selecionadas.
 * - Imagens não selecionadas ou de anexos internos são substituídas por placeholder seguro.
 */
export function sanitizeAndRewriteMarkdown(
  markdown: string,
  options: {
    selectedAttachmentIds?: string[];
    shareToken?: string;
  } = {}
): string {
  if (!markdown || typeof markdown !== 'string') return markdown;

  const { selectedAttachmentIds = [], shareToken } = options;
  const selectedSet = new Set(selectedAttachmentIds);

  // 1. Sanitização de tags HTML perigosas
  let safe = markdown
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/javascript\s*:/gi, 'about:blank')
    .replace(/\bon\w+\s*=/gi, 'data-disabled=');

  // 2. Reescreve imagens Markdown: ![alt](url)
  // Formatos esperados: /api/v1/projects/attachments/:id/download ou attachments/:id
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;

  safe = safe.replace(imageRegex, (match, altText, url) => {
    // Tenta extrair ID de anexo da URL
    const attachmentMatch = url.match(/(?:attachments\/)([a-zA-Z0-9_-]+)/);
    if (attachmentMatch) {
      const attId = attachmentMatch[1];
      if (selectedSet.has(attId) && shareToken) {
        return `![${altText}](/api/v1/projects/public/shares/${shareToken}/attachments/${attId})`;
      } else {
        return `![${altText || 'Imagem privada não compartilhada'}](about:blank)`;
      }
    }

    // Se for URL externa segura (https/http), preserva
    if (/^https?:\/\//i.test(url)) {
      return match;
    }

    return `![${altText}](about:blank)`;
  });

  return safe;
}

/**
 * Construtor Único do Conteúdo Público (E2.2-c / E3.7-c / Seção 5.2).
 * Utilizado de forma idêntica pela Prévia Interna e pelo DTO Público (TaskPublicDTO).
 * 
 * Regras Estritas:
 * 1. Título sempre visível.
 * 2. Descrição incluída apenas se showDescription === true (sanitizada e com imagens reescritas).
 * 3. Status, prioridade e datas incluídos por padrão.
 * 4. Checklist/subtarefas incluídas como seção somente leitura se showSubtasks === true.
 * 5. Recursos/links incluídos APENAS se showResources === true e estiverem explicitamente
 *    selecionados em selectedResourceIds (novos itens criados na tarefa nascem privados!).
 * 6. Anexos incluídos APENAS se showAttachments === true e estiverem explicitamente
 *    selecionados em selectedAttachmentIds (novos itens criados nascem privados!).
 * 7. Invariante: Anexos de comentários NUNCA são expostos publicamente.
 * 8. NUNCA expor: comentários, apontamento de horas, valores financeiros, atividades,
 *    relações de dependência, usuários internos (nomes, e-mails, avatares), tokens ou PINs.
 */
export function buildPublicCard(task: any, options: BuildPublicCardOptions = {}): TaskPublicDTO {
  const {
    showDescription = true,
    showSubtasks = true,
    showResources = true,
    showAttachments = true,
    showCustomFields = true,
    selectedResourceIds = [],
    selectedAttachmentIds = [],
    selectedCustomFieldIds = [],
    shareToken,
    publicContentUpdatedAt = null,
  } = options;

  // 1. Checklist seguro (apenas id, title, completed)
  let checklist: Array<{ id: string; title: string; completed: boolean }> | undefined = undefined;
  if (showSubtasks && Array.isArray(task.subtasks)) {
    checklist = task.subtasks.map((s: any) => ({
      id: s.id,
      title: s.title,
      completed: Boolean(s.completed),
    }));
  }

  // 2. Recursos selecionados explicitamente (whitelist por ID)
  let resources: Array<{ id: string; title: string; url: string; type: string }> | undefined = undefined;
  if (showResources && Array.isArray(task.resources)) {
    const selectedSet = new Set(selectedResourceIds);
    resources = task.resources
      .filter((r: any) => selectedSet.has(r.id))
      .map((r: any) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        type: r.type || 'other',
      }));
  }

  // 3. Anexos selecionados explicitamente (whitelist por ID) (E3.7-c / T10)
  let attachments: Array<{
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    downloadUrl: string;
  }> | undefined = undefined;

  if (showAttachments && Array.isArray(task.attachments)) {
    const selectedSet = new Set(selectedAttachmentIds);
    attachments = task.attachments
      .filter((a: any) => selectedSet.has(a.id) && !a.commentId) // Invariante: comentários são sempre internos
      .map((a: any) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        downloadUrl: shareToken
          ? `/api/v1/projects/public/shares/${shareToken}/attachments/${a.id}`
          : `/api/v1/projects/attachments/${a.id}/download`,
      }));
  }

  // 4. Campos personalizados selecionados explicitamente (E3.8-a / T10)
  // Regra Estrita:
  // - showCustomFields === true
  // - campo explicitamente incluído em selectedCustomFieldIds (whitelist)
  // - campo DEVE ter isPublicEligible === true (configurado por ADMIN)
  // - valor formatado de forma limpa (se select, resolver label da opção)
  let customFields: Array<{ name: string; value: string }> | undefined = undefined;
  const valuesList = task.fieldValues || task.customFieldValues || task.values;
  if (showCustomFields && Array.isArray(valuesList)) {
    const selectedSet = new Set(selectedCustomFieldIds);

    customFields = valuesList
      .filter((v: any) => {
        const field = v.field;
        return (
          field &&
          selectedSet.has(field.id) &&
          Boolean(field.isPublicEligible) &&
          v.value !== null &&
          v.value !== undefined &&
          v.value !== ''
        );
      })
      .map((v: any) => {
        let displayVal = String(v.value);
        if (v.field.type === 'select' && Array.isArray(v.field.options)) {
          const opt = v.field.options.find((o: any) => o.id === v.value);
          if (opt) displayVal = opt.label;
        }
        return {
          name: v.field.name,
          value: displayVal,
        };
      });
  }

  // 5. Descrição sanitizada com imagens reescritas (E3.7-d)
  let safeDescription: string | null = null;
  if (showDescription && task.description) {
    safeDescription = sanitizeAndRewriteMarkdown(task.description, {
      selectedAttachmentIds,
      shareToken,
    });
  }

  // 6. Determina data do conteúdo público
  const updatedAtDate = publicContentUpdatedAt
    ? new Date(publicContentUpdatedAt).toISOString()
    : task.updatedAt
    ? new Date(task.updatedAt).toISOString()
    : new Date().toISOString();

  // 7. Retorna DTO seguro
  return {
    taskId: task.id,
    title: task.title,
    description: safeDescription,
    status: task.column?.name || 'Em Aberto',
    priority: task.priority || 'MEDIUM',
    startDate: formatCivilDate(task.startDate),
    dueDate: formatCivilDate(task.dueDate),
    checklist,
    resources,
    attachments,
    customFields,
    publicContentUpdatedAt: updatedAtDate,
  };
}
