import { Component } from 'react'

export default class ErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="app" role="alert">
          <h1>Something went wrong</h1>
          <p>The screen could not be displayed. Don't repeat a payment until you've checked your wallet.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload app
          </button>
        </main>
      )
    return this.props.children
  }
}
