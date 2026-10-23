// The main process bundle (electron-vite) and vitest both resolve `?raw` imports through Vite.
declare module '*.sql?raw' {
  const sql: string
  export default sql
}
