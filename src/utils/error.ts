class ApiError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(statusCode: number, message: string, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  toResponse() {
    return {
      status: "error",
      statusCode: this.statusCode,
      message: this.message
    };
  }
}

export default ApiError;
