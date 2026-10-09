// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ContextPickerField, ModelPickerField, parseContextWindow } from '../src/client/TeamMemberEditor.tsx'
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
