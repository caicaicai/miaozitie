# 部署到 Cloudflare Pages 指南

## 📋 前提条件

1. 拥有 [Cloudflare](https://www.cloudflare.com/) 账号
2. 拥有 [GitHub](https://github.com/) 账号
3. 本地已安装 Git

## 🚀 部署步骤

### 方法一：通过 GitHub 部署（推荐）

#### 1. 创建 GitHub 仓库

```bash
# 在 GitHub 上创建一个新的空仓库（不要添加 README、.gitignore 或 license）
# 仓库名建议：miaozitie 或 chinese-writing-practice
```

#### 2. 推送代码到 GitHub

```bash
# 添加远程仓库
git remote add origin https://github.com/你的用户名/仓库名.git

# 推送到 GitHub
git branch -M main
git push -u origin main
```

#### 3. 连接到 Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击左侧菜单 **Workers & Pages**
3. 点击 **Create application**
4. 选择 **Pages** 标签页
5. 点击 **Connect to Git**
6. 授权 Cloudflare 访问你的 GitHub 账号
7. 选择刚才创建的仓库

#### 4. 配置构建设置

由于这是纯静态 HTML 项目，配置如下：

- **Project name**: miaozitie（或自定义）
- **Production branch**: main
- **Build command**: （留空）
- **Build output directory**: `/`（根目录）

#### 5. 部署

1. 点击 **Save and Deploy**
2. 等待部署完成（通常 1-2 分钟）
3. 部署成功后，你会得到一个 `.pages.dev` 域名

### 方法二：直接上传部署

#### 1. 访问 Cloudflare Pages

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击 **Workers & Pages**
3. 点击 **Create application**
4. 选择 **Pages** 标签页
5. 选择 **Upload assets**

#### 2. 准备文件

将以下文件打包（不需要 .git 目录）：
- `stroke-by-stroke.html`
- `ziku.txt`
- `README.md`
- `.cursor/` 目录（可选）

#### 3. 上传并部署

1. 点击 **Upload**
2. 选择文件或拖拽上传
3. 等待部署完成

## 🌐 自定义域名（可选）

如果你有自己的域名：

1. 在 Cloudflare Pages 项目设置中
2. 点击 **Custom domains**
3. 点击 **Set up a custom domain**
4. 输入你的域名
5. 按照提示配置 DNS 记录

## 🔄 自动部署

通过 GitHub 部署的好处是，每次你推送新的代码到仓库时，Cloudflare Pages 会自动重新部署：

```bash
# 修改代码后
git add .
git commit -m "更新描述"
git push
```

## 📝 环境变量（本项目不需要）

本项目是纯前端静态页面，不需要配置环境变量。

## 🎯 访问你的网站

部署成功后，你的网站地址将是：
- `https://你的项目名.pages.dev`
- 或你的自定义域名

## ⚡ 性能优化建议

Cloudflare Pages 自动提供：
- ✅ 全球 CDN 加速
- ✅ 自动 HTTPS
- ✅ 无限带宽
- ✅ DDoS 防护
- ✅ 自动缓存

## 🐛 常见问题

### Q: 页面显示 404
A: 确保 `stroke-by-stroke.html` 在根目录，或者设置为默认首页

### Q: 外部库加载失败
A: 本项目使用 CDN 加载 Hanzi Writer 和 Pinyin Pro，确保网络连接正常

### Q: 如何更新网站
A: 推送新代码到 GitHub，Cloudflare 会自动部署；或直接在 Cloudflare Pages 重新上传

## 📞 获取帮助

- [Cloudflare Pages 文档](https://developers.cloudflare.com/pages/)
- [Cloudflare 社区](https://community.cloudflare.com/)

---

祝你部署顺利！🎉

