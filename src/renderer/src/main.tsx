import './assets/globals.css'
import './lib/i18n'
import './lib/drop' // wire preload file-drop → active chat input
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/components/theme-provider'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from '@/App'
import { StandaloneSession } from '@/components/standalone-session'

// pop-out windows load with ?session=<id> and render just that session
const sessionId = new URLSearchParams(window.location.search).get('session')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        {sessionId ? <StandaloneSession sessionId={sessionId} /> : <App />}
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
