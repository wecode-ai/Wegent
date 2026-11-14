declare module '*.css'
declare module '*?worker' {
  const WorkerFactory: { new (): Worker }
  export default WorkerFactory
}
