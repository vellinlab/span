# Span 项目约定

- 编译、打包和安装测试统一在 GitHub Actions 上运行。本地仅做编辑和轻量检查。
- 使用 SemVer。`Cargo.toml` 和 `Cargo.lock` 的项目版本保持一致，Git 标签为 `v` 加项目版本。常规修复合并到计划中的补丁版，一次发布只递增一次。次版本和主版本留给符合 SemVer 的功能里程碑与兼容性变化。
- 用 `-alpha.N`、`-beta.N` 和 `-rc.N` 区分预发布阶段。同一阶段再次发布时递增后缀数字。候选版通过验收后，正式版只去掉预发布后缀。
- 推送版本标签后，GitHub Actions 在两个平台的构建与安装测试通过后发布 Release。预发布标记为 GitHub Pre-release，正式版本进入稳定发布渠道。
