# VPS動画処理サーバー構築手順

## ??? VPS環境セットアップ

### 1. 基本環境構築
```bash
# システム更新
sudo apt update && sudo apt upgrade -y

# 必要パッケージインストール
sudo apt install -y ffmpeg nodejs npm nginx

# Node.js最新版
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# スワップ追加（メモリ不足対策）
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
```

### 2. 作業ディレクトリ作成
```bash
mkdir -p /home/video-processor
cd /home/video-processor
mkdir -p tmp/uploads tmp/processed tmp/thumbnails
```

## ?? 処理サーバー実装

### 3. package.json作成
```bash
npm init -y
npm install express multer uuid child_process @aws-sdk/client-s3
```

### 4. server.js作成
```javascript
import express from 'express';
import multer from 'multer';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { uploadToR2 } from './r2Upload.js';

const app = express();
const upload = multer({ 
  dest: 'tmp/uploads',
  limits: { fileSize: 200 * 1024 * 1024 }
});

// 認証ミドルウェア
const authenticateRequest = (req, res, next) => {
  const authToken = req.headers.authorization;
  if (authToken !== `Bearer ${process.env.CMS_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.post('/api/process-video', authenticateRequest, upload.single('video'), async (req, res) => {
  const tempPath = req.file?.path;
  if (!tempPath) return res.status(400).json({ error: 'No file' });

  const uuid = uuidv4();
  const outputPath = `tmp/processed/${uuid}.mp4`;
  const thumbnailPath = `tmp/thumbnails/${uuid}.webp`;

  try {
    // ウォーターマーク付き動画処理（本サイト仕様と同じ）
    execSync(`
      ffmpeg -i "${tempPath}" \\
        -i watermark.png \\
        -filter_complex "[1]scale=200:-1,format=rgba,colorchannelmixer=aa=0.3[wm];[0][wm]overlay=W-w-10:H-h-10" \\
        -vcodec libx264 \\
        -crf 28 \\
        -preset fast \\
        -movflags +faststart \\
        -threads 2 \\
        "${outputPath}"
    `);

    // サムネイル生成
    execSync(`
      ffmpeg -i "${outputPath}" \\
        -vf "select=eq(n\\,0),scale=640:360" \\
        -frames:v 1 \\
        "${thumbnailPath}"
    `);

    // R2アップロード
    const [videoUrl, thumbnailUrl] = await Promise.all([
      uploadToR2(outputPath, `videos/${uuid}.mp4`),
      uploadToR2(thumbnailPath, `thumbnails/${uuid}.webp`)
    ]);

    res.json({ 
      success: true,
      url: videoUrl,
      thumbnail: thumbnailUrl,
      uuid
    });

  } catch (error) {
    console.error('Video processing error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // 一時ファイル削除
    [tempPath, outputPath, thumbnailPath].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
});

// ヘルスチェック
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(3001, () => {
  console.log('?? Video processing server running on port 3001');
});
```

### 5. package.jsonのtype設定
```json
{
  "type": "module",
  "scripts": {
    "start": "node server.js"
  }
}
```

## ?? Nginx設定

### 6. Nginx設定ファイル作成
```bash
sudo nano /etc/nginx/sites-available/video-processor
```

```nginx
server {
    listen 80;
    server_name your-vps-ip;
    
    client_max_body_size 200M;
    proxy_read_timeout 300s;
    
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 7. Nginx有効化
```bash
sudo ln -s /etc/nginx/sites-available/video-processor /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## ?? サーバー起動

### 8. PM2で自動起動設定
```bash
npm install -g pm2
cd /home/video-processor
pm2 start server.js --name video-processor
pm2 startup
pm2 save
```

## ?? CMS側の実装

### 9. components/VideoUploader.tsx 修正
```typescript
const processVideo = async (file: File) => {
  const formData = new FormData();
  formData.append('video', file);
  
  try {
    setProcessing(true);
    
    const response = await fetch(`${process.env.NEXT_PUBLIC_VPS_URL}/api/process-video`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_VPS_SECRET}`
      },
      body: formData
    });
    
    const result = await response.json();
    
    if (result.success) {
      const videoMarkdown = `<video controls poster="${result.thumbnail}">
  <source src="${result.url}" type="video/mp4">
</video>`;
      
      // エディターに挿入
      onChange(value + '\n\n' + videoMarkdown);
      
      // 成功メッセージ
      console.log(`動画処理完了: ${result.uuid}`);
    } else {
      throw new Error(result.error || 'Processing failed');
    }
    
  } catch (error) {
    console.error('VPS video processing failed:', error);
    alert('VPS処理に失敗しました。ローカルでscripts/buildPost.mjsを実行してください。');
  } finally {
    setProcessing(false);
  }
};
```

## ? テスト

### 10. 動作確認
```bash
# サーバー起動確認
pm2 status

# ログ確認
pm2 logs video-processor

# 手動テスト
curl -X POST -F "video=@test.mp4" http://your-vps-ip/api/process-video
```

## ?? 追加実装が必要なファイル

### 1. r2Upload.js作成（必須）
```javascript
// r2Upload.js
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
  const fileBuffer = fs.readFileSync(filePath);
  
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: key.endsWith('.mp4') ? 'video/mp4' : 'image/webp',
  });

  await s3Client.send(command);
  return `https://img.kawasaki-create.com/${key}`;
}
```

### 2. watermark.png配置（必須）
```bash
# 本サイトからウォーターマーク画像をコピー
scp /home/user/local/new-static-blog/watermark.png user@vps-ip:/opt/video-processor/
```

### 3. 環境変数設定（必須）
```bash
# /opt/video-processor/.env
CMS_SECRET=your-secure-random-token
R2_ACCESS_KEY=your-r2-access-key
R2_SECRET_KEY=your-r2-secret-key
R2_BUCKET=blog-images
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
```

### 4. CMS側環境変数（必須）
```bash
# /home/user/local/blog-cms/.env.local
NEXT_PUBLIC_VPS_URL=http://your-vps-ip
NEXT_PUBLIC_VPS_SECRET=your-secure-random-token
```

### 5. パッケージ追加
```bash
# VPS上で実行
npm install dotenv
```

### 6. server.js修正（dotenv追加）
```javascript
// server.jsの最上部に追加
import 'dotenv/config';
```

## ?? トラブルシューティング

### メモリ不足の場合
```bash
# スワップ使用量確認
free -h

# プロセス確認
htop
```

### FFmpeg エラーの場合
```bash
# FFmpeg動作確認
ffmpeg -version

# 手動実行テスト
ffmpeg -i test.mp4 -vcodec libx264 -crf 28 output.mp4
```
