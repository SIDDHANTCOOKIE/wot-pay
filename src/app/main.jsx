import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/instrument-serif/400.css'
import './app.css'

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>)
