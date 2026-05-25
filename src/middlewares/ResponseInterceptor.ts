import { Interceptor, InterceptorInterface, Action } from "routing-controllers";

@Interceptor()
export class ResponseInterceptor implements InterceptorInterface {
  intercept(action: Action, content: any) {
    if (action.response.headersSent || (content && content.headersSent)) {
      return content;
    }
    return this.transform(content, new WeakSet());
  }

  private transform(obj: any, visited: WeakSet<any>): any {
    if (obj === null || obj === undefined) return obj;

    // Handle primitive types early
    if (typeof obj !== "object") return obj;

    // Handle Date
    if (obj instanceof Date) return obj;

    // Detect circular references
    if (visited.has(obj)) return "[Circular]";
    visited.add(obj);

    // If it's a MongoDB ObjectId
    if (obj.constructor && obj.constructor.name === "ObjectId") {
      return obj.toString();
    }

    // If it looks like the Buffer structure the user showed
    if (obj.buffer && obj.buffer.type === "Buffer" && typeof obj.toString === "function") {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.transform(item, visited));
    }

    // Generic object transformation
    const newObj: any = {};
    for (const key in obj) {
      // Avoid traversing internal properties (often prefixed with _)
      // Except for _id which is specifically what we want
      if (key.startsWith("_") && key !== "_id") continue;

      try {
        newObj[key] = this.transform(obj[key], visited);
      } catch (e) {
        console.log(e);

        // Fallback for properties that might throw on access
        newObj[key] = obj[key];
      }
    }
    return newObj;
  }
}
