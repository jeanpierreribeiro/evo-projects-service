export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: any;

  constructor(statusCode: number, code: string, message: string, details?: any) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Não autorizado.', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Acesso negado para esta operação no workspace.', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado.', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflito de recursos.', code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class VersionConflictError extends AppError {
  constructor(message = 'Conflito de versão. O registro foi modificado por outra operação.', currentVersion?: number) {
    super(409, 'VERSION_CONFLICT', message, currentVersion !== undefined ? { currentVersion } : undefined);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dados inválidos.', details?: any, code = 'VALIDATION_ERROR') {
    super(400, code, message, details);
  }
}

export class GoneError extends AppError {
  constructor(message = 'Recurso ou funcionalidade removida.', code = 'LEGACY_FEATURE_REMOVED') {
    super(410, code, message);
  }
}
