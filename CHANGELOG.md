# AI Hub Changelog

## v0.6.4

### 简体中文

- **大图上传** · 纳入 [DeepSeek Chat Demo v0.1.3](https://github.com/deepseek-ai/chat-demo/releases/tag/v0.1.3) 的修复。发给 DeepSeek 时，长边超过 4096 像素的图片会等比缩小，浏览器和账号同步仍保留原图。
- **历史图片复用** · 在另一台设备恢复旧会话后，超限的历史图片会按需从同步原件补传。合规的附件继续复用，更新后的附件 ID 随会话同步。
- **搜索与弹窗** · 缩短入场动画。会话搜索保留高斯模糊，结果区一次展开并淡入。
- **版本号** · 在「设置 → 通用设置」底部查看当前构建版本。

提供 Web 和 Server ZIP 及其 SHA-256 校验文件。

### English

- **Large image uploads** · Includes the [DeepSeek Chat Demo v0.1.3](https://github.com/deepseek-ai/chat-demo/releases/tag/v0.1.3) fix. Images sent to DeepSeek are scaled proportionally if their longest edge exceeds 4096 pixels. Browser storage and account sync retain the originals.
- **Image reuse across devices** · When a restored chat references an oversized image, AI Hub reuploads it from the synced original as needed. In-limit attachments are reused, and updated file IDs sync with the conversation.
- **Search and dialogs** · Shorter entrance animations. Search keeps its blurred backdrop, and the result pane expands once and fades in.
- **Version number** · Find the current build version at the bottom of Settings → General.

Web and Server ZIPs include SHA-256 checksums.

## v0.6.2

AI Hub 首个公开版本，基于 [DeepSeek Chat Demo v0.1.2](https://github.com/deepseek-ai/chat-demo/releases/tag/v0.1.2)。

### 简体中文

- **多模型接入** · 支持 DeepSeek 与 OpenAI 兼容接口。在输入框切换模型，在设置中获取模型、调整目录顺序、显示名与参数。
- **会话管理** · 搜索会话标题与当前分支的消息，支持批量置顶、取消置顶和删除。可导入 DeepSeek 历史 ZIP，导出保留模型引用和可用的附件原件。
- **可选的账号同步** · 使用自建 Gitea 登录，跨设备同步历史、附件、草稿和偏好。服务器对同步数据与 API Key 加密保存。
- **附件体验** · 从草稿或历史消息预览支持的图片和 PDF，并下载可用的原件。

下载 **Web ZIP** 通过浏览器使用，或下载 **Server ZIP** 部署 Gitea 登录与同步服务。两个包均附 SHA-256 校验文件。 [中文使用指南](https://github.com/ApakohZzz/AIHub-deepseek-chatdemo-modified/blob/v0.6.2/README.zh-CN.md)

### English

The first public release of AI Hub is based on [DeepSeek Chat Demo v0.1.2](https://github.com/deepseek-ai/chat-demo/releases/tag/v0.1.2).

- **Multiple model providers** · Configure DeepSeek and OpenAI-compatible APIs. Switch models from the composer and manage model discovery, order, display names, and limits in Settings.
- **Conversation management** · Search titles and active-branch messages. Pin, unpin, or delete chats in bulk. Import DeepSeek history ZIPs and export model references and available original attachments.
- **Optional account sync** · Sign in with your own Gitea instance to sync chats, attachments, drafts, and preferences across devices. Synced data and API keys are encrypted at rest.
- **Attachment previews** · Preview supported images and PDFs in drafts and history, and download available originals.

Choose the **Web ZIP** for browser storage or the **Server ZIP** for Gitea sign-in and sync. Both packages come with SHA-256 checksums. [Installation guide](https://github.com/ApakohZzz/AIHub-deepseek-chatdemo-modified/blob/v0.6.2/README.md)
