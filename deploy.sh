#!/bin/bash

# デプロイスクリプト for video-processor
# 使い方: ./deploy.sh

echo "========================================="
echo "🎬 Video Processor Deployment Script"
echo "========================================="

# 現在のディレクトリを確認
if [ ! -f "server.js" ]; then
    echo "❌ Error: server.js not found. Run this script from the process-video directory."
    exit 1
fi

echo ""
echo "📥 Pulling latest changes..."
git pull

if [ $? -ne 0 ]; then
    echo "❌ Git pull failed. Please resolve conflicts manually."
    exit 1
fi

echo ""
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install failed."
    exit 1
fi

echo ""
echo "🔄 Restarting PM2 process..."
pm2 restart video-processor

if [ $? -ne 0 ]; then
    echo "⚠️  PM2 restart failed. Trying to start..."
    pm2 start server.js --name video-processor
fi

echo ""
echo "📊 Current PM2 status:"
pm2 status video-processor

echo ""
echo "========================================="
echo "✅ Video Processor deployment complete!"
echo "========================================="

# ログを少し表示
echo ""
echo "📜 Recent logs:"
pm2 logs video-processor --lines 5 --nostream