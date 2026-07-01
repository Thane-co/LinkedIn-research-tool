// Layer 5 — dashboard entry (PRD §12 step 31). On mount, check /api/settings readiness ->
// onboarding (SettingsPanel) or dashboard; load creators + first page of posts.
// TDD: renders onboarding when keys missing; dashboard when ready.

export default function Page() {
  return (
    <main>
      {/* TODO(PRD §12 step 31): readiness gate -> <SettingsPanel/> onboarding or <DashboardClient/> */}
      <h1>Viral Post Research Tool</h1>
      <p>Scaffold — UI not yet implemented (see PRD §12, Layer 5).</p>
    </main>
  )
}
