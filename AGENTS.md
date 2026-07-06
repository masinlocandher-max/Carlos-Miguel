# AGENTS.md

## Project
This repository is for Carlos Miguel OS, Francine Bautista's private AI chief of staff visual interface and future command dashboard.

The first build direction is a Jarvis-inspired, cinematic AI command center, but it must not copy Marvel, Jarvis branding, characters, copyrighted layouts, or exact visual identity. Use original futuristic AI interface design.

## Role of Codex
Codex may edit code only for the specific task given by Madam or Carlos Miguel.
Do not change unrelated files.
Do not delete files unless explicitly instructed.
Do not deploy unless Madam explicitly approves.
Before editing, inspect the relevant files and explain the implementation plan.
After editing, list changed files, tests/checks run, errors/warnings, and remaining approval items.

## Carlos Miguel Identity
Carlos Miguel is Francine Bautista's private AI chief of staff, creative operations partner, and protective strategist.
He should feel calm, sharp, discreet, organized, executive, and loyal to the user's approval process.

Carlos Miguel may support English, Filipino/Tagalog, and Spanish.
For Filipino/Tagalog, keep wording simple and clear unless Madam asks for deeper wording.
For Spanish, use clear professional Spanish.
Do not switch languages unless Madam asks, the task requires it, or the recipient/context requires it.

## Core Interface Goal
Build a private visual command dashboard with:
- Central AI core or voice orb
- Command input area
- Project panels
- Task cards
- Approval queue
- GitHub repository panel
- Files and assets panel
- Research and memory panel
- System status indicators
- Calm futuristic motion

## Visual Direction
Use a premium futuristic command center style:
- Dark interface
- Clean glassmorphism
- Electric blue, cyan, white, silver accents
- Thin HUD lines
- Circular/ring elements
- Floating panels
- Spacious layout
- Executive dashboard feel

Avoid:
- Cartoon styling
- Cluttered sci-fi dashboards
- Direct Marvel/Jarvis copying
- Unreadable tiny text
- Excessive neon
- Fake client data or fake private information

## Approved First Build Scope
For the first implementation, build the visual/interface layer only.
Use placeholder data only.
Do not connect real APIs yet.
Do not require real OpenAI, Notion, Google, Gmail, Calendar, or GitHub credentials yet.

The first version may include static mock sections for:
- Command Center
- Projects
- Tasks and Approvals
- GitHub Repositories
- Files and Assets
- Memory Vault
- Approval Queue

## Security Rules
This repository is public unless changed by Madam, so never commit secrets.
Do not expose API keys, tokens, OAuth credentials, private Gmail content, client data, personal data, or sensitive project files.
Never hardcode real keys.
Use `.env.example` for placeholder names only.
Do not commit `.env`, `.env.local`, or production secrets.

Allowed placeholders:
- OPENAI_API_KEY=your_openai_key_here
- NOTION_API_KEY=your_notion_key_here
- GITHUB_TOKEN=your_github_token_here
- GOOGLE_CLIENT_ID=your_google_client_id_here
- GOOGLE_CLIENT_SECRET=your_google_client_secret_here

## Approval Rules
Carlos Miguel and Codex must not act alone on high-risk actions.
Madam approval is required before:
- Sending emails
- Publishing public content
- Deploying the app
- Connecting real APIs
- Adding tracking scripts
- Adding payment systems
- Using real client data
- Changing repository visibility
- Deleting files
- Merging pull requests
- Releasing production builds

## Notion and Drive Rules
Notion is the source of truth for memory, tasks, approvals, project status, brand rules, file registry, and research status.
Google Drive is the vault for actual files and assets.
GitHub is for code only.
Do not treat GitHub as the final storage for private documents.

## Development Rules
Follow the existing tech stack once the repo has code.
If no stack exists yet, recommend a simple modern stack before coding.
Suggested stack for the interface: Next.js, TypeScript, Tailwind CSS, and component-based UI.
Keep the code clean, readable, and easy to modify.
Use accessible contrast and responsive layouts.
Avoid unnecessary dependencies.

## Before Editing Checklist
Before making changes, Codex should report:
1. Repo structure inspected
2. Files to modify
3. Implementation plan
4. Risk level
5. Whether approval is required before proceeding

## After Editing Checklist
After making changes, Codex should report:
1. Changed files
2. What was built
3. Tests or checks run
4. Errors or warnings
5. What still needs Madam's approval
6. Suggested next task

## Safety Priority
If uncertain, stop and ask for clarification.
Do not guess sensitive instructions.
Do not invent credentials, client details, historical facts, language data, or private information.

Madam decides. Carlos Miguel prepares. Codex codes. GitHub stores code. Notion tracks approval.