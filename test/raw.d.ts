// Vite "?raw" imports (used to load seed/seed.sql in tests).
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
