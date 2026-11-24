import { useLayoutEffect, useRef, useState } from 'react';
import { CircleHelp, ShieldCheck } from 'lucide-react';
import { PathText } from './file-reference-name.jsx';

function InteractionInput({ field }) {
  const [other, setOther] = useState(false);
  const choices = field.options ?? [];
  const useText = !choices.length || field.secret || other;
  return <label>{field.label}
    {field.description && <small>{field.description}</small>}
    {choices.length > 0 && !field.secret && <select aria-label={field.label} required={field.required && !other}
      name={other ? undefined : field.id} onChange={event => setOther(event.target.value === '@other')}>
      <option value="">请选择</option>
      {choices.map(choice => <option key={choice.id} value={choice.id} title={choice.description}>{choice.label}</option>)}
      {field.allowOther && <option value="@other">其他</option>}
    </select>}
    {useText && (field.multiline && !field.secret
      ? <textarea name={field.id} required={field.required} defaultValue={field.prefill} rows={2} />
      : <input name={field.id} required={field.required} type={field.secret ? 'password' : 'text'}
        defaultValue={field.prefill} />)}
  </label>;
}

function ApprovalDetails({ request, item }) {
  const operation = request.operation;
  const command = operation?.kind === 'command' ? operation.command || item?.command : undefined;
  const cwd = operation?.cwd || item?.cwd;
  const files = operation?.kind === 'files' ? item?.files?.map(file => file.path).filter(Boolean) : undefined;
  const permissions = operation?.permissions;
  return <>
    {(cwd || operation?.target || operation?.root) && <dl className="approval-context">
      {cwd && <div><dt>工作目录</dt><dd><PathText path={cwd} /></dd></div>}
      {operation?.target && <div><dt>目标</dt><dd>{[operation.protocol, operation.target].filter(Boolean).join(' · ')}</dd></div>}
      {operation?.root && <div><dt>写入范围</dt><dd><PathText path={operation.root} /></dd></div>}
    </dl>}
    {(command || files?.length || permissions) ? <div className="approval-operation">
      {command && <pre aria-label="待执行命令">{command}</pre>}
      {Boolean(files?.length) && <pre aria-label="待修改文件">{files.join('\n')}</pre>}
      {permissions && <pre aria-label="请求的权限">{JSON.stringify(permissions, null, 2)}</pre>}
    </div> : null}
    {request.detail && <p className="approval-reason">{request.detail}</p>}
  </>;
}

function InteractionCard({ request, count, respond, item, host, focusTarget, onFocus, onBlur }) {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const approval = request.kind === 'approval';
  const Icon = approval ? ShieldCheck : CircleHelp;

  async function answer(reply) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure('');
    try { await respond(request.id, reply); }
    catch (error) { setFailure(error.message || '提交失败，请重试。'); }
    finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const actions = <div className="approval-actions">
    {failure && <span className="approval-error" role="alert">{failure}</span>}
    {request.cancel && <button type="button" aria-disabled={busy || undefined}
      onClick={() => answer({ cancelled: true })}>取消</button>}
    {approval ? request.choices.map(choice => <button type="button" key={choice.id} aria-disabled={busy || undefined}
      data-effect={choice.effect} onClick={() => answer({ choice: choice.id })}>{choice.label}</button>)
      : <button className="primary" aria-disabled={busy || undefined}>提交回答</button>}
  </div>;
  return <section className="approval" aria-label={request.title} ref={focusTarget} tabIndex={-1}
    onFocusCapture={onFocus} onBlurCapture={onBlur} data-kind={request.kind} aria-busy={busy || undefined}>
    <header><Icon size={16} aria-hidden="true" /><strong>{request.title}</strong>
      {count > 1 && <small>还有 {count - 1} 项</small>}<small className="approval-host" title={host}>{host}</small></header>
    {approval ? <>
      <div className="approval-body" role="group" aria-label="操作详情" tabIndex={0}>
        <ApprovalDetails request={request} item={item} />
      </div>
      {actions}
    </> : <form onSubmit={event => {
      event.preventDefault();
      answer({ values: Object.fromEntries(new FormData(event.currentTarget)) });
    }}>
      <div className="approval-body">
        {request.detail && <p className="approval-reason">{request.detail}</p>}
        {request.fields.map(field => <InteractionInput key={field.id} field={field} />)}
      </div>
      {actions}
    </form>}
  </section>;
}

export function Interactions({ requests, respond, item, host, focusTarget, returnFocus }) {
  const request = requests[0];
  const key = request ? JSON.stringify([request.turnId, request.id]) : null;
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!hadFocus.current) return;
    if (focusTarget.current) focusTarget.current.focus({ preventScroll: true });
    else {
      hadFocus.current = false;
      returnFocus.current?.focus({ preventScroll: true });
    }
  }, [key, focusTarget, returnFocus]);
  return request && <InteractionCard key={key} request={request} count={requests.length} respond={respond} item={item} host={host}
    focusTarget={focusTarget} onFocus={() => { hadFocus.current = true; }} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) hadFocus.current = false;
    }} />;
}
