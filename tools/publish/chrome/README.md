
# Chrome Web Store 发布指引

## 准备
1. 在 Google Cloud Console 创建 OAuth2 凭据（桌面/网页应用皆可），获取：
   - `CWS_CLIENT_ID`
   - `CWS_CLIENT_SECRET`
2. 在 Chrome Web Store Developer Dashboard 创建扩展条目，获取：
   - `CWS_EXTENSION_ID`
3. 生成 `CWS_REFRESH_TOKEN`（使用你的 OAuth 客户端为你的 Google 账号生成 refresh token）。

> 详细步骤可参考官方文档“使用 OAuth 与 Webstore API 上传与发布”。

## 打包与发布
```bash
npm run build
npm run build:zip     # 生成 release/*.zip
CWS_EXTENSION_ID=xxx \
CWS_CLIENT_ID=xxx \
CWS_CLIENT_SECRET=xxx \
CWS_REFRESH_TOKEN=xxx \
node tools/publish/chrome/publish.mjs release/你的zip文件.zip
```
