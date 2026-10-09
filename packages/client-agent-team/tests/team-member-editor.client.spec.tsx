// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamMemberId, AgentTeamMemberPromptView, AgentTeamMemberResult, AgentTeamUpdateMemberRequest } from '@wowyuarm/dsh-agent-team/types'
import { ContextPickerField, MemberPromptDialog, ModelPickerField, parseContextWindow } from '../src/client/TeamMemberEditor.tsx'
import { zh } from '../src/client/locales.ts'
import type { TeamModelCatalog } from '../src/client/slots.ts'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof ModelPickerField>[0]['t']

const CATALOG: TeamModelCatalog = {
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
  failures: [],
}

const catalogOk = (): RemoteResult<TeamModelCatalog> => ({ ok: true, value: CATALOG }) as RemoteResult<TeamModelCatalog>
const catalogRefused = (message: string): RemoteResult<TeamModelCatalog> =>
  ({ ok: false, error: { message } }) as RemoteResult<TeamModelCatalog>

function renderPicker(loadModels: () => Promise<RemoteResult<TeamModelCatalog>>) {
  return render(
    <ModelPickerField model={undefined} onModelChange={() => {}} loadModels={loadModels} disabled={false} t={t} />,
  )
}

describe('ModelPickerField catalog load', () => {
  it('renders the trigger once the shared catalog resolves', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    renderPicker(loadModels)
    expect(screen.getByText('正在加载模型目录…')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('turns a synchronously refused read into a retryable error instead of endless loading', async () => {
    const loadModels = vi.fn((): Promise<RemoteResult<TeamModelCatalog>> => {
      throw new Error('remote.session is unavailable')
    })
    renderPicker(loadModels)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('remote.session is unavailable')
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    expect(screen.queryByRole('button', { name: '模型' })).toBeNull()
  })

  it('retries a rejected read and renders the trigger once the retry resolves', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    loadModels.mockRejectedValueOnce(new Error('transport died mid-call'))
    renderPicker(loadModels)
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(loadModels).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight read across concurrent mounts', async () => {
    let resolveLoad!: (result: RemoteResult<TeamModelCatalog>) => void
    const loadModels = vi.fn(() => new Promise<RemoteResult<TeamModelCatalog>>((resolve) => { resolveLoad = resolve }))
    renderPicker(loadModels)
    renderPicker(loadModels)
    await waitFor(() => { expect(loadModels).toHaveBeenCalledTimes(1) })
    resolveLoad(catalogOk())
    expect(await screen.findAllByRole('button', { name: '模型' })).toHaveLength(2)
    expect(loadModels).toHaveBeenCalledTimes(1)
  })

  it('opens with cached rows while revalidating in the background', async () => {
    const loadModels = vi.fn(async () => catalogOk())
    const first = renderPicker(loadModels)
    expect(await screen.findByRole('button', { name: '模型' })).toBeTruthy()
    first.unmount()
    let resolveSecond!: (result: RemoteResult<TeamModelCatalog>) => void
    loadModels.mockImplementationOnce(() => new Promise<RemoteResult<TeamModelCatalog>>((resolve) => { resolveSecond = resolve }))
    renderPicker(loadModels)
    // The revalidation is still pending, yet the warmed rows render at once.
    expect(screen.getByRole('button', { name: '模型' })).toBeTruthy()
    expect(screen.queryByText('正在加载模型目录…')).toBeNull()
    resolveSecond(catalogOk())
    await waitFor(() => { expect(loadModels).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole('button', { name: '模型' })).toBeTruthy()
  })

  it('keeps the answered refusal visible with a retry entry', async () => {
    const loadModels = vi.fn(async () => catalogRefused('catalog unavailable'))
    renderPicker(loadModels)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('catalog unavailable')
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})

describe('ContextPickerField', () => {
  it('renders the stored intent and commits the picked policy through the menu', async () => {
    const onPolicyChange = vi.fn()
    const onWindowTextChange = vi.fn()
    render(
      <ContextPickerField
        policy="fresh"
        onPolicyChange={onPolicyChange}
        windowText="96000"
        onWindowTextChange={onWindowTextChange}
        invalid={false}
        disabled={false}
        t={t}
      />,
    )
    expect(screen.getByRole('button', { name: '任务启动上下文' }).textContent).toBe('每个任务全新上下文')
    expect((screen.getByLabelText('上下文窗口覆盖') as HTMLInputElement).value).toBe('96000')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '任务启动上下文' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '延续当前上下文' }))
    expect(onPolicyChange).toHaveBeenCalledWith('continue')
    fireEvent.change(screen.getByLabelText('上下文窗口覆盖'), { target: { value: '128000' } })
    expect(onWindowTextChange).toHaveBeenCalledWith('128000')
  })

  it('states the invalid window in place of the hint and marks the field', () => {
    render(
      <ContextPickerField
        policy="continue"
        onPolicyChange={() => {}}
        windowText="100"
        onWindowTextChange={() => {}}
        invalid
        disabled={false}
        t={t}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe('上下文窗口必须是不小于 8192 的整数。')
    expect(screen.queryByText('以 token 计；只会收窄模型路由窗口，不会放大（最低 8192）。')).toBeNull()
    expect(screen.getByLabelText('上下文窗口覆盖').getAttribute('aria-invalid')).toBe('true')
  })
})

describe('parseContextWindow', () => {
  it('maps the empty text to follow-the-route and gates everything below the floor', () => {
    expect(parseContextWindow('')).toBeUndefined()
    expect(parseContextWindow('  ')).toBeUndefined()
    expect(parseContextWindow('8192')).toBe(8192)
    expect(parseContextWindow('96000')).toBe(96000)
    expect(parseContextWindow('8191')).toBeNaN()
    expect(parseContextWindow('8192.5')).toBeNaN()
    expect(parseContextWindow('-1')).toBeNaN()
    expect(parseContextWindow('abc')).toBeNaN()
    expect(parseContextWindow('9'.repeat(400))).toBeNaN()
  })
})

const promptMemberId = 'member:prompt-1' as AgentTeamMemberId

function promptView(overrides: Partial<AgentTeamMemberPromptView> = {}): AgentTeamMemberPromptView {
  return {
    memberId: promptMemberId,
    handle: 'builder',
    description: 'Builds changes',
    state: 'enabled',
    prompt: { customPrompt: 'Stored paragraph.' },
    ...overrides,
  }
}

const viewOk = (value: AgentTeamMemberPromptView): Promise<RemoteResult<AgentTeamMemberPromptView>> =>
  Promise.resolve({ ok: true, value } as RemoteResult<AgentTeamMemberPromptView>)
// A plain impl (not a shared vi.fn): each test wraps it in its own `vi.fn`, so
// call records never leak between tests.
const updateCommit = async (_request: AgentTeamUpdateMemberRequest): Promise<RemoteResult<AgentTeamMemberResult>> =>
  ({ ok: true, value: {} }) as unknown as RemoteResult<AgentTeamMemberResult>

describe('MemberPromptDialog stage mode', () => {
  it('stages a local paragraph with a live UTF-8 byte counter and refuses to apply an over-limit one', () => {
    const onApply = vi.fn()
    render(<MemberPromptDialog mode="stage" initialText="已有段落" onApply={onApply} onClose={() => {}} t={t} />)
    const box = screen.getByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    expect(box.value).toBe('已有段落')
    // Four CJK characters measure 12 UTF-8 bytes, not 4 code units.
    expect(screen.getByText('12 / 8192 字节')).toBeTruthy()
    fireEvent.change(box, { target: { value: '段'.repeat(2731) } })
    expect(screen.getByRole('alert').textContent).toBe('超出 8192 字节上限（当前 8193 字节），请精简后再保存。')
    expect((screen.getByRole('button', { name: '应用' }) as HTMLButtonElement).disabled).toBe(true)
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(box, { target: { value: '新段落' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(onApply).toHaveBeenCalledWith('新段落')
  })
})

describe('MemberPromptDialog edit mode', () => {
  it('loads the stored paragraph, commits an echo-complete update, and reports the merged profile', async () => {
    const loadPromptView = vi.fn(() => viewOk(promptView({ prompt: { droppedSections: ['skills'], customPrompt: 'Stored paragraph.', autoPrune: true } })))
    const updateMember = vi.fn(updateCommit)
    const onCommitted = vi.fn()
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateMember}
        onCommitted={onCommitted}
        onClose={() => {}}
        t={t}
      />,
    )
    const box = await screen.findByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    expect(box.value).toBe('Stored paragraph.')
    fireEvent.change(box, { target: { value: 'New paragraph.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateMember).toHaveBeenCalledTimes(1))
    const request = updateMember.mock.calls[0]![0] as AgentTeamUpdateMemberRequest
    // Merge, never replace: the other profile subfields survive a paragraph
    // edit, and absent-clears makes the stored echo inputs ride the commit.
    expect(request.prompt).toEqual({ droppedSections: ['skills'], customPrompt: 'New paragraph.', autoPrune: true })
    expect(request.handle).toBe('builder')
    expect(request.description).toBe('Builds changes')
    expect(onCommitted).toHaveBeenCalledWith({ droppedSections: ['skills'], customPrompt: 'New paragraph.', autoPrune: true })
  })

  it('merges drops committed while the dialog stood open instead of restoring them', async () => {
    // A full-auto sweep commits droppedSections while the dialog stands open:
    // the open read is stale, so the save re-reads the stored drops first and
    // merges them in — the stale echo never resurrects what the Host removed.
    const staleView = promptView({ prompt: { customPrompt: 'Stored paragraph.', autoPrune: true } })
    const sweptView = promptView({ prompt: { droppedSections: ['tool:bash'], customPrompt: 'Stored paragraph.', autoPrune: true } })
    const loadPromptView = vi.fn()
      .mockImplementationOnce(() => viewOk(staleView))
      .mockImplementation(() => viewOk(sweptView))
    const updateMember = vi.fn(updateCommit)
    const onCommitted = vi.fn()
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateMember}
        onCommitted={onCommitted}
        onClose={() => {}}
        t={t}
      />,
    )
    const box = await screen.findByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'New paragraph.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateMember).toHaveBeenCalledTimes(1))
    expect(loadPromptView).toHaveBeenCalledTimes(2)
    const request = updateMember.mock.calls[0]![0] as AgentTeamUpdateMemberRequest
    // The Host's sweep drop rides the echo even though the stale dialog never
    // saw it; the Human's paragraph edit survives alongside it.
    expect(request.prompt).toEqual({ droppedSections: ['tool:bash'], customPrompt: 'New paragraph.', autoPrune: true })
    expect(onCommitted).toHaveBeenCalledWith({ droppedSections: ['tool:bash'], customPrompt: 'New paragraph.', autoPrune: true })
  })

  it('saves the local list unchanged when the pre-save re-read fails', async () => {
    const loadPromptView = vi.fn()
      .mockImplementationOnce(() => viewOk(promptView({ prompt: { customPrompt: 'Stored paragraph.' } })))
      .mockImplementation(() => Promise.resolve({ ok: false, error: { message: 'read refused' } }) as Promise<RemoteResult<AgentTeamMemberPromptView>>)
    const updateMember = vi.fn(updateCommit)
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateMember}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    const box = await screen.findByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'New paragraph.' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(updateMember).toHaveBeenCalledTimes(1))
    const request = updateMember.mock.calls[0]![0] as AgentTeamUpdateMemberRequest
    expect(request.prompt).toEqual({ customPrompt: 'New paragraph.' })
  })

  it('keeps the save disabled while the paragraph is untouched', async () => {
    const loadPromptView = vi.fn(() => viewOk(promptView({ prompt: { customPrompt: 'Stored paragraph.' } })))
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={vi.fn(updateCommit)}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    await screen.findByRole('textbox', { name: '自定义角色段落' })
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the save disabled while the paragraph exceeds the byte limit', async () => {
    const loadPromptView = vi.fn(() => viewOk(promptView()))
    const updateMember = vi.fn(updateCommit)
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateMember}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    const box = await screen.findByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '段'.repeat(2731) } })
    expect(screen.getByRole('alert').textContent).toBe('超出 8192 字节上限（当前 8193 字节），请精简后再保存。')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect(updateMember).not.toHaveBeenCalled()
  })

  it('renders a non-enabled Member read-only with the save disabled', async () => {
    const loadPromptView = vi.fn(() => viewOk(promptView({ state: 'suspended' })))
    const updateMember = vi.fn(updateCommit)
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateMember}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    const box = await screen.findByRole('textbox', { name: '自定义角色段落' }) as HTMLTextAreaElement
    expect(box.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('该成员当前不是启用状态，段落以只读展示。')).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect(updateMember).not.toHaveBeenCalled()
  })

  it('renders the read failure with a retry entry that reloads the view', async () => {
    const loadPromptView = vi.fn(() => Promise.resolve({ ok: false, error: { message: 'read refused' } }) as Promise<RemoteResult<AgentTeamMemberPromptView>>)
    render(
      <MemberPromptDialog
        mode="edit"
        memberId={promptMemberId}
        loadPromptView={loadPromptView}
        updateMember={updateCommit}
        onCommitted={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('段落读取失败：read refused')
    expect(screen.queryByRole('textbox', { name: '自定义角色段落' })).toBeNull()
    loadPromptView.mockImplementation(() => viewOk(promptView()))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('textbox', { name: '自定义角色段落' })).toBeTruthy()
    expect(loadPromptView).toHaveBeenCalledTimes(2)
  })
})
