import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/instrument-serif/400.css'
import './app.css'

createRoot(document.getElementById('root')).render(<App />)

// Installation only; the worker does not cache the payment app or its data.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // A failed worker registration must not prevent ordinary web use.
    })
  })
}
