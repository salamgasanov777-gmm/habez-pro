// Единственный тип ошибки, который API отдаёт наружу. Всё остальное
// превращается в 500 без подробностей — стек в лог, клиенту только id.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg = "Некорректный запрос", details) => new ApiError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Требуется вход") => new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "Недостаточно прав") => new ApiError(403, "forbidden", msg);
export const notFound = (msg = "Не найдено") => new ApiError(404, "not_found", msg);
export const conflict = (msg = "Конфликт данных") => new ApiError(409, "conflict", msg);
export const tooMany = (msg = "Слишком много попыток, подождите") => new ApiError(429, "too_many_requests", msg);
