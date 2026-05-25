import fs from "fs";
import path from "path";
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg"];
const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

class ImageService {

  /* ----------------------------------------
     IMAGE UPLOAD (BASE64)
    ---------------------------------------- */
  async imageUpload(
    base64: string,
    folder: string,
    fileName: string,
    oldFileName?: string
  ): Promise<boolean> {
    try {
      const base64Data = base64.replace(/^data:.*;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");

      const folderPath = path.join(process.cwd(), "public", folder);
      const newFilePath = path.join(folderPath, fileName);

      // Ensure directory exists
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      // Delete old file safely
      if (oldFileName) {
        const oldPath = path.join(folderPath, oldFileName);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      await fs.promises.writeFile(newFilePath, buffer);
      return true;
    } catch (error) {
      console.error("imageUpload error:", error);
      return false;
    }
  }

  /* ----------------------------------------
     FILE UPLOAD (multipart/form-data)
    ---------------------------------------- */
  async fileUpload(
    file: any,
    folder: string,
    fileName: string,
    oldFileName?: string
  ): Promise<boolean> {
    try {
      if (!file || !file.data) return false;

      const folderPath = path.join(process.cwd(), "public", folder);
      const filePath = path.join(folderPath, fileName);

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      // Delete old file
      if (oldFileName) {
        const oldPath = path.join(folderPath, oldFileName);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      // Convert mv() to Promise
      await new Promise<void>((resolve, reject) => {
        file.mv(filePath, (err: any) => {
          if (err) return reject(err);
          resolve();
        });
      });

      return true;
    } catch (error) {
      console.error("fileUpload error:", error);
      return false;
    }
  }

  /* ----------------------------------------
     DELETE IMAGE
    ---------------------------------------- */
  async deleteImage(
    folder: string,
    fileName: string
  ): Promise<boolean> {
    try {
      const filePath = path.join(process.cwd(), "public", folder, fileName);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      return true;
    } catch (error) {
      console.error("deleteImage error:", error);
      return false;
    }
  }

  /* ----------------------------------------
     BUFFER FILE UPLOAD
    ---------------------------------------- */
  async fileUploadForBufferData(
    fileBuffer: Buffer,
    folder: string,
    fileName: string,
    oldFileName?: string
  ): Promise<boolean> {
    try {
      const folderPath = path.join(process.cwd(), "public", folder);
      const filePath = path.join(folderPath, fileName);

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      if (oldFileName) {
        const oldPath = path.join(folderPath, oldFileName);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      await fs.promises.writeFile(filePath, fileBuffer);
      return true;
    } catch (error) {
      console.error("fileUploadForBufferData error:", error);
      return false;
    }
  }
  async validateImageFile(file: any) {
    if (!file) {
      throw new Error("File not found");
    }

    const extension = path.extname(file.name).toLowerCase();
    const mimeType = file.mimetype;

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      throw new Error("Invalid file extension. Allowed: png, jpg, jpeg");
    }

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error("Invalid file type. Only images allowed");
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error("File size exceeds 2MB limit");
    }

    return extension;
  }
}

const imageService = new ImageService();
export default imageService;
