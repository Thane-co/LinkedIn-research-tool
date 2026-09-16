'use client'
// Layer 5 — §23: whose LinkedIn posts count as "mine". Provided once by the app shell from the
// own_linkedin_author_id setting, so every PostCard (grid, image groups, content clusters) can offer the
// comment thread on her posts without threading a prop through each view.

import { createContext } from 'react'

export const OwnAuthorContext = createContext<string | null>(null)
