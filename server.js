import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { uploadToR2 } from './r2Upload.js';

const app = express();
const PORT = process.env.PORT || 3001;

const upload = multer({ 
  dest: 'tmp/uploads',
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(express.json());

// 認証ミドルウェア
const authenticateRequest = (req, res, next) => {
  const authToken = req.headers.authorization;
  if (authToken !== `Bearer ${process.env.CMS_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/api/process-video', authenticateRequest, upload.single('video'), async (req, res) => {
  const tempPath = req.file?.path;
  if (!tempPath) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const uuid = uuidv4();
  const outputPath = `tmp/processed/${uuid}.mp4`;
  const thumbnailPath = `tmp/thumbnails/${uuid}.webp`;

  console.log(`Processing video: ${tempPath} -> ${outputPath}`);

  try {
    console.log('Starting video processing with watermark...');
    
    // ウォーターマーク付き動画処理
    if (fs.existsSync('watermark.png')) {
      execSync(`
        ffmpeg -i "${tempPath}" \\
          -i watermark.png \\
          -filter_complex "[1]scale=200:-1,format=rgba,colorchannelmixer=aa=0.3[wm];[0:v]scale=-2:720[scaled];[scaled][wm]overlay=W-w-10:H-h-10" \\
          -vcodec libx264 \\
          -crf 28 \\
          -preset fast \\
          -movflags +faststart \\
          -threads 2 \\
          -y \\
          "${outputPath}"
      `, { stdio: 'inherit' });
    } else {
      console.warn('watermark.png not found, processing without watermark');
      execSync(`
        ffmpeg -i "${tempPath}" \\
          -vf "scale=-2:720" \\
          -vcodec libx264 \\
          -crf 28 \\
          -preset fast \\
          -movflags +faststart \\
          -threads 2 \\
          -y \\
          "${outputPath}"
      `, { stdio: 'inherit' });
    }

    console.log('Generating thumbnail...');
    execSync(`
      ffmpeg -i "${outputPath}" \\
        -vf "select=eq(n\\,0),scale=640:360" \\
        -frames:v 1 \\
        -y \\
        "${thumbnailPath}"
    `, { stdio: 'inherit' });

    console.log('Uploading to R2...');
    // R2アップロード
    const [videoUrl, thumbnailUrl] = await Promise.all([
      uploadToR2(outputPath, `videos/${uuid}.mp4`),
      uploadToR2(thumbnailPath, `thumbnails/${uuid}.webp`)
    ]);

    console.log(`Video processing completed: ${uuid}`);
    
    res.json({ 
      success: true,
      uuid: uuid,
      url: videoUrl,
      thumbnail: thumbnailUrl,
      message: 'Video processed successfully'
    });

  } catch (error) {
    console.error('Video processing error:', error.message);
    res.status(500).json({ 
      error: 'Video processing failed',
      details: error.message 
    });
  } finally {
    [tempPath, outputPath, thumbnailPath].forEach(file => {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
          console.log(`Cleaned up: ${file}`);
        } catch (cleanupError) {
          console.warn(`Failed to cleanup: ${file}`, cleanupError.message);
        }
      }
    });
  }
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🎬 Video processing server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});