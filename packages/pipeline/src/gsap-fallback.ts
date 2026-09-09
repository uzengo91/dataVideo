/** GSAP 兜底：无法从 node_modules 定位时，用 npm 安装的包或内置最小占位。
 *  实际运行时 pipeline 会先尝试 pnpm dlx gsap 缓存；此文件只防构建失败。 */
export default `/* gsap placeholder — composeWorkspace 必须提供真实 gsap.min.js */
`;
