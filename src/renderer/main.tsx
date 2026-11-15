import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme'
import './app/i18n'
import { App } from './app/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
