import swaggerJsdoc from "swagger-jsdoc";
import * as dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 4000;

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Thinai Backend API",
      version: "1.0.0",
      description: "API Documentation"
    },
    servers: [
      {
        url: `http://localhost:${PORT}` // ✅ FIXED
      }
    ]
  },

  apis: ["src/controllers/**/*.ts", "src/dto/**/*.ts"]
};

export const swaggerSpec = swaggerJsdoc(options);
