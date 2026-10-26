// vite.config.ts: caption font files that are installed, by font id
declare module 'virtual:caption-fonts' {
  const files: Record<string, string>;
  export default files;
}
