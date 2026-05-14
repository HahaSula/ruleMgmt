import { useState } from 'react'
import AlertTypeEditor from './pages/AlertTypeEditor'
import AlertSuiteEditor from './pages/AlertSuiteEditor'
import ReceiversEditor from './pages/ReceiversEditor'
import GitopsEditor from './pages/GitopsEditor'
import PromQLEditor from './pages/PromQLEditor'
import AlertmanagerSmartEditor from './pages/AlertmanagerSmartEditor'
import AlertTypePackEditor from './pages/AlertTypePackEditor'
import RuleTableEditor from './pages/RuleTableEditor'

const NAV_ITEMS = [
  { id: 'alert-type',   label: 'Alert Type',        icon: '⚡' },
  { id: 'alert-pack',   label: 'Alert Pack',         icon: '📋' },
  { id: 'alert-suite',  label: 'Rule Group',         icon: '📦' },
  { id: 'receivers',    label: 'Receivers',          icon: '📣' },
  { id: 'amconfig',     label: 'AM Config',          icon: '🔀' },
  { id: 'gitops',       label: 'Gitops Deploy',      icon: '🚀' },
  { id: 'promql',       label: 'PromQL Builder',     icon: '📊' },
  { id: 'rule-table',  label: 'Rule Editor',        icon: '📝' },
]

export default function App() {
  const [page, setPage] = useState('alert-type')
  const [sidebarFolded, setSidebarFolded] = useState(false)

  return (
    <div className="app">
      <nav className={`sidebar${sidebarFolded ? ' sidebar-folded' : ''}`}>
        {sidebarFolded ? (
          <>
            <button className="sidebar-fold-btn" onClick={() => setSidebarFolded(false)} title="Expand">›</button>
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className={`nav-item nav-item-icon${page === item.id ? ' active' : ''}`}
                onClick={() => setPage(item.id)}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            <div className="sidebar-title">
              Alert Template UI
              <button className="sidebar-fold-btn" onClick={() => setSidebarFolded(true)} title="Collapse">‹</button>
            </div>
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
          </>
        )}
      </nav>
      <main className="content">
        {page === 'alert-type'  && <AlertTypeEditor />}
        {page === 'alert-pack'  && <AlertTypePackEditor />}
        {page === 'alert-suite' && <AlertSuiteEditor />}
        {page === 'receivers'   && <ReceiversEditor />}
        {page === 'amconfig'    && <AlertmanagerSmartEditor />}
        {page === 'gitops'      && <GitopsEditor />}
        {page === 'promql'      && <PromQLEditor onNavigate={setPage} />}
        {page === 'rule-table'  && <RuleTableEditor />}
      </main>
    </div>
  )
}
