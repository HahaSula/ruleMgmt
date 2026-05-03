import { useState } from 'react'
import AlertTypeEditor from './pages/AlertTypeEditor'
import AlertSuiteEditor from './pages/AlertSuiteEditor'
import ReceiversEditor from './pages/ReceiversEditor'
import SystemEditor from './pages/SystemEditor'
import GitopsEditor from './pages/GitopsEditor'
import PromQLEditor from './pages/PromQLEditor'
import AlertmanagerConfigEditor from './pages/AlertmanagerConfigEditor'

const NAV_ITEMS = [
  { id: 'alert-type',   label: 'Alert Type',        icon: '⚡' },
  { id: 'alert-suite',  label: 'Rule Group',         icon: '📦' },
  { id: 'receivers',    label: 'Receivers',          icon: '📣' },
  { id: 'amconfig',     label: 'Alertmanager Config',icon: '🔀' },
  { id: 'system',       label: 'System',             icon: '🔧' },
  { id: 'gitops',       label: 'Gitops Deploy',      icon: '🚀' },
  { id: 'promql',       label: 'PromQL Builder',     icon: '📊' },
]

export default function App() {
  const [page, setPage] = useState('alert-type')

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-title">Alert Template UI</div>
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            className={`nav-item${page === item.id ? ' active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {page === 'alert-type'  && <AlertTypeEditor />}
        {page === 'alert-suite' && <AlertSuiteEditor />}
        {page === 'receivers'   && <ReceiversEditor />}
        {page === 'system'      && <SystemEditor />}
        {page === 'amconfig'    && <AlertmanagerConfigEditor />}
        {page === 'gitops'      && <GitopsEditor />}
        {page === 'promql'      && <PromQLEditor onNavigate={setPage} />}
      </main>
    </div>
  )
}
