interface ResponseType {
    status: (statusCode: number) => {
        json: (body: object) => void;
    };
}

interface CommonResponseProps {
    res: any;
    statusCode: number;
    message: string;
    data?: any;
}

class CommonResponse implements CommonResponseProps {
  res: ResponseType;
  statusCode: number;
  message: string;
  data: any;

  constructor(res: ResponseType, statusCode: number, message: string, data: any = null) {
    if (!res || !statusCode || !message) {
      throw new Error("Missing required parameters: res, statusCode, message");
    }
    this.res = res;
    this.statusCode = statusCode;
    this.message = message;
    this.data = data;
  }

  send() {
    try {
      return this.res.status(this.statusCode).json({
        statusCode: this.statusCode,
        message: this.message,
        data: this.data
      });
    } catch (error) {
      console.error("Error in send method:", error);
      throw new Error("Failed to send response");
    }
  }
}

const response = (res: any, statusCode: number, message: string, data: any = null) => {
  return new CommonResponse(res, statusCode, message, data).send();
};

export default response;
