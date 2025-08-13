import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

export async function uploadToR2(filePath, key) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: key.endsWith('.mp4') ? 'video/mp4' : 'image/webp',
    });

    await s3Client.send(command);
    console.log(`Successfully uploaded: ${key}`);
    return `https://img.kawasaki-create.com/${key}`;
  } catch (error) {
    console.error(`Failed to upload ${key}:`, error);
    throw new Error(`R2 upload failed: ${error.message}`);
  }
}