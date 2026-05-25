import { WorkbenchProvider } from '@/features/workbench/WorkbenchProvider'
import { WorkbenchPage } from '@/pages/WorkbenchPage'

export default function App() {
  return (
    <WorkbenchProvider>
      <WorkbenchPage />
    </WorkbenchProvider>
  )
}
