// 根级入口：让 `magpie plugin add github:cat-clash/magpie-qiniu` 直装可用。
// magpie 的 github: 安装按「仓库根 package.json 的 main/exports 或根级 index.mjs」找入口，
// 本仓库插件本体在 plugin/ 子目录，这里做一层转发。
export * from "./plugin/index.mjs";
