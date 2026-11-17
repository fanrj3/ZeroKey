"""Local project credentials for LiteLLM. Secrets never appear in CLI output."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent
CONFIG_NAME = '.zerokey.json'
DEFAULT_MODEL = 'opencode-go/gpt-6-luna'


class BrokerError(Exception):
    pass


@contextmanager
def project_lock(project: Path):
    """Do not issue competing credentials for one project in concurrent agents."""
    api = ctypes.WinDLL('Kernel32.dll', use_last_error=True)
    api.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    api.CreateMutexW.restype = wintypes.HANDLE
    api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    api.WaitForSingleObject.restype = wintypes.DWORD
    api.ReleaseMutex.argtypes = [wintypes.HANDLE]
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    name = 'Local\\ZeroKey-' + credential_target(project).rsplit('/', 1)[-1]
    handle = api.CreateMutexW(None, False, name)
    if not handle:
        raise BrokerError('Cannot lock the project for credential changes.')
    acquired = False
    try:
        acquired = api.WaitForSingleObject(handle, 0) in (0, 0x80)
        if not acquired:
            raise BrokerError('Another authorization is already in progress for this project.')
        yield
    finally:
        if acquired:
            api.ReleaseMutex(handle)
        api.CloseHandle(handle)


def project_path(value: str | Path) -> Path:
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise BrokerError('Project must be an existing folder.')
    return path


def credential_target(project: Path) -> str:
    identity = os.path.normcase(str(project.resolve())).encode('utf-8')
    return 'ZeroKey/project/' + hashlib.sha256(identity).hexdigest()[:32]


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode('utf-8')).hexdigest()


def read_env(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            name, value = line.split('=', 1)
            result[name.strip()] = value.strip().strip('\"\'')
    return result


def gateway_url() -> str:
    values = read_env(ROOT / '.env')
    port = values.get('LITELLM_PORT', '4000')
    if not port.isdigit() or not 1 <= int(port) <= 65535:
        raise BrokerError('Invalid local gateway port.')
    return f'http://127.0.0.1:{port}'


class Gateway:
    def __init__(self):
        values = read_env(ROOT / '.env')
        self.base = gateway_url()
        self._master = values.get('LITELLM_MASTER_KEY')
        if not self._master:
            raise BrokerError('The local gateway master key is missing.')

    def request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode('utf-8')
        request = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={'Authorization': 'Bearer ' + self._master,
                     'Content-Type': 'application/json', 'User-Agent': 'ZeroKey-Broker/1.0'},
        )
        # Local gateway requests must never follow a redirect carrying credentials.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise BrokerError(f'Gateway {method} {path.split("?")[0]} failed (HTTP {exc.code}).') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            raise BrokerError('Cannot reach the local LiteLLM gateway, or its response is invalid.') from None

    def models(self) -> list[str]:
        return sorted(row['id'] for row in self.request('GET', '/v1/models')['data']
                      if row['id'].startswith(('bbai/', 'opencode-go/', 'opencode-payg/')))

    def info(self, fingerprint: str):
        if not re.fullmatch('[0-9a-f]{64}', fingerprint):
            raise BrokerError('Invalid project key reference.')
        return self.request('GET', '/key/info?key=' + fingerprint)['info']

    def revoke(self, key: str):
        self.request('POST', '/key/delete', {'keys': [key]})


class WindowsCredentials:
    """Generic credentials protected by the current Windows user's account."""

    def __init__(self):
        if os.name != 'nt':
            raise BrokerError('This broker currently requires Windows Credential Manager.')

        class Credential(ctypes.Structure):
            _fields_ = [
                ('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
                ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
                ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)),
                ('Persist', wintypes.DWORD), ('AttributeCount', wintypes.DWORD),
                ('Attributes', ctypes.c_void_p), ('TargetAlias', wintypes.LPWSTR),
                ('UserName', wintypes.LPWSTR),
            ]

        self.Credential = Credential
        self.api = ctypes.WinDLL('Advapi32.dll', use_last_error=True)
        self.api.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
        self.api.CredWriteW.restype = wintypes.BOOL
        self.api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.POINTER(ctypes.POINTER(Credential))]
        self.api.CredReadW.restype = wintypes.BOOL
        self.api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        self.api.CredDeleteW.restype = wintypes.BOOL
        self.api.CredFree.argtypes = [ctypes.c_void_p]
        self.api.CredFree.restype = None

    def read(self, target: str) -> str | None:
        pointer = ctypes.POINTER(self.Credential)()
        if not self.api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
            if ctypes.get_last_error() == 1168:
                return None
            raise BrokerError('Cannot read Windows Credential Manager. Run in your normal desktop session.')
        try:
            row = pointer.contents
            return ctypes.string_at(row.CredentialBlob, row.CredentialBlobSize).decode('utf-16-le')
        finally:
            self.api.CredFree(pointer)

    def write(self, target: str, key: str):
        blob = key.encode('utf-16-le')
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        row = self.Credential()
        row.Type, row.Persist = 1, 2
        row.TargetName, row.UserName = target, 'LiteLLM virtual key'
        row.Comment = 'ZeroKey project credential; upstream keys stay at the gateway.'
        row.CredentialBlobSize = len(blob)
        row.CredentialBlob = buffer
        if not self.api.CredWriteW(ctypes.byref(row), 0):
            raise BrokerError('Cannot save the project key in Windows Credential Manager.')

    def delete(self, target: str):
        if not self.api.CredDeleteW(target, 1, 0) and ctypes.get_last_error() != 1168:
            raise BrokerError('Cannot delete the project credential from Windows Credential Manager.')


def load_config(project: Path) -> dict | None:
    path = project / CONFIG_NAME
    if path.is_symlink():
        raise BrokerError('The ZeroKey project configuration cannot be a symbolic link.')
    if not path.exists():
        return None
    try:
        config = json.loads(path.read_text(encoding='utf-8'))
        if config.get('schema_version') != 1 or config.get('credential_target') != credential_target(project):
            raise BrokerError('This ZeroKey configuration belongs to a different project folder.')
        if config.get('gateway') != gateway_url():
            raise BrokerError('The project gateway does not match the configured local gateway.')
        if not isinstance(config.get('models'), list) or not config['models']:
            raise BrokerError('The project model configuration is invalid.')
        if not re.fullmatch('[0-9a-f]{64}', config.get('key_hash', '')):
            raise BrokerError('The project key reference is invalid.')
        return config
    except (ValueError, TypeError, AttributeError):
        raise BrokerError('The ZeroKey project configuration is invalid.') from None


def save_config(project: Path, config: dict):
    destination = project / CONFIG_NAME
    if destination.is_symlink():
        raise BrokerError('The ZeroKey project configuration cannot be a symbolic link.')
    fd, temporary = tempfile.mkstemp(prefix='.zerokey-', suffix='.tmp', dir=project)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def hello(mode: str, message: str = '') -> str:
    if os.name != 'nt':
        raise BrokerError('Windows Hello is required for granting a project credential.')
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    result = subprocess.run(
        [str(powershell), '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
         '-File', str(ROOT / 'scripts/windows-consent.ps1'), '-Mode', mode, '-Message', message],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else 'Unavailable'


def confirm_grant(project: Path, request: dict):
    import tkinter as tk
    from tkinter import messagebox, ttk

    window = tk.Tk()
    window.title('ZeroKey · 项目授权')
    window.geometry('640x500')
    window.minsize(600, 460)
    window.attributes('-topmost', True)
    window.lift()
    approved = False
    frame = ttk.Frame(window, padding=24)
    frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='为项目配置模型访问', font=('Microsoft YaHei UI', 17, 'bold')).pack(anchor='w', pady=(0, 16))
    expiry = request.get('duration') or '长期有效，直到撤销'
    details = [
        ('应用', request['app']), ('项目', str(project)),
        ('模型', '\n'.join(request['models'])),
        ('预算', f"每天 ${request['max_budget']:g}（按网关估算费用限制）"),
        ('有效期', expiry), ('保存位置', 'Windows 凭据管理器'),
    ]
    for label, value in details:
        ttk.Label(frame, text=label, font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', pady=(5, 0))
        ttk.Label(frame, text=value, wraplength=575).pack(anchor='w')
    ttk.Label(frame, text='确认后使用 Windows Hello 验证。以后在本项目中直接复用。',
              wraplength=575).pack(anchor='w', pady=(18, 12))
    buttons = ttk.Frame(frame)
    buttons.pack(fill='x', side='bottom')

    def approve():
        nonlocal approved
        grant_button.state(['disabled'])
        window.update()
        try:
            result = hello('Verify', 'ZeroKey: ' + request['app'] + ' | ' + ', '.join(request['models']))
            if result == 'Verified':
                approved = True
                window.destroy()
                return
            messagebox.showerror('未完成授权', 'Windows Hello 未通过：' + result, parent=window)
        except (OSError, subprocess.TimeoutExpired):
            messagebox.showerror('未完成授权', 'Windows Hello 无法完成验证，请在正常桌面会话中重试。', parent=window)
        grant_button.state(['!disabled'])

    ttk.Button(buttons, text='取消', command=window.destroy).pack(side='right', padx=(12, 0))
    grant_button = ttk.Button(buttons, text='使用 Windows Hello 授权', command=approve)
    grant_button.pack(side='right')
    window.protocol('WM_DELETE_WINDOW', window.destroy)
    window.mainloop()
    if not approved:
        raise BrokerError('Authorization canceled. No key was issued.')


def request_spec(app: str, models: list[str], budget: float, duration: str | None) -> dict:
    if not app.strip() or len(app) > 100 or any(ord(c) < 32 for c in app):
        raise BrokerError('App name must contain 1 to 100 printable characters.')
    if not math.isfinite(budget) or budget <= 0 or budget > 10:
        raise BrokerError('Daily budget must be greater than 0 and at most $10.')
    if not models or any(not model or '*' in model for model in models):
        raise BrokerError('Select at least one explicit model; wildcards are not allowed.')
    if duration and not re.fullmatch(r'[1-9][0-9]*[smhd]', duration):
        raise BrokerError('Duration must be omitted for no expiry, or use a value such as 7d.')
    return {'app': app.strip(), 'models': sorted(set(models)), 'max_budget': budget,
            'budget_duration': '1d', 'duration': duration}


def provision(project: Path, spec: dict, gateway: Gateway, store: WindowsCredentials, consent=confirm_grant) -> dict:
    config = load_config(project)
    target = credential_target(project)
    old_key = store.read(target)
    same = config and all(config.get(name) == value for name, value in spec.items())
    if same and old_key and key_hash(old_key) == config['key_hash']:
        info = gateway.info(config['key_hash'])
        if info.get('status') == 'active' and not info.get('blocked'):
            return {'status': 'reused', 'project': str(project), 'models': config['models'],
                    'expires': info.get('expires'), 'daily_budget': info.get('max_budget')}

    missing = set(spec['models']) - set(gateway.models())
    if missing:
        raise BrokerError('Models are not available: ' + ', '.join(sorted(missing)))
    consent(project, spec)
    body = {'key_alias': 'zerokey/' + spec['app'] + '/' + uuid.uuid4().hex[:8],
            'models': spec['models'], 'max_budget': spec['max_budget'], 'budget_duration': '1d',
            'key_type': 'llm_api', 'metadata': {'app': spec['app'], 'project': str(project), 'managed_by': 'ZeroKey'}}
    if spec['duration']:
        body['duration'] = spec['duration']
    issued = gateway.request('POST', '/key/generate', body)
    new_key = issued.get('key')
    if not isinstance(new_key, str) or not new_key.startswith('sk-'):
        raise BrokerError('The gateway did not issue a valid virtual key.')
    new_config = {**spec, 'schema_version': 1, 'gateway': gateway.base,
                  'credential_target': target, 'key_hash': key_hash(new_key),
                  'key_alias': body['key_alias'], 'expires': issued.get('expires')}
    try:
        store.write(target, new_key)
        save_config(project, new_config)
    except Exception:
        try:
            if old_key:
                store.write(target, old_key)
            else:
                store.delete(target)
        finally:
            gateway.revoke(new_key)
        raise
    if old_key:
        try:
            gateway.revoke(old_key)
        except BrokerError:
            return {'status': 'provisioned', 'project': str(project), 'models': spec['models'],
                    'expires': issued.get('expires'), 'daily_budget': spec['max_budget'],
                    'notice': 'New key is ready; revoke the previous project key in the dashboard.'}
    return {'status': 'provisioned', 'project': str(project), 'models': spec['models'],
            'expires': issued.get('expires'), 'daily_budget': spec['max_budget']}


def project_environment(project: Path, store: WindowsCredentials, session: str | None = None) -> dict[str, str]:
    config = load_config(project)
    if not config:
        raise BrokerError('Project is not configured. Run provision first.')
    key = store.read(credential_target(project))
    if not key or key_hash(key) != config['key_hash']:
        raise BrokerError('Project credential is missing or mismatched. Run provision again.')
    environment = os.environ.copy()
    for name in (
        'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY', 'POSTGRES_PASSWORD',
        'BBAI_API_KEY', 'OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY',
        'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
        'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'COHERE_API_KEY', 'AZURE_API_KEY',
        'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
        'XAI_API_KEY', 'PERPLEXITY_API_KEY',
    ):
        environment.pop(name, None)
    environment.update({'OPENAI_API_KEY': key, 'LLM_API_KEY': key,
                        'OPENAI_BASE_URL': config['gateway'] + '/v1', 'LLM_BASE_URL': config['gateway'] + '/v1',
                        'OPENAI_MODEL': config['models'][0], 'LLM_MODEL': config['models'][0],
                        'LITELLM_SESSION_ID': session or 'ses_zerokey_' + uuid.uuid4().hex})
    return environment


def cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('models', help='List configured source model names without secrets.')
    commands.add_parser('doctor', help='Check local gateway and Windows authorization availability.')
    grant = commands.add_parser('provision', help='Authorize or reuse a project credential.')
    grant.add_argument('--project', required=True)
    grant.add_argument('--app')
    grant.add_argument('--models', nargs='+', default=[DEFAULT_MODEL])
    grant.add_argument('--budget', type=float, default=1)
    grant.add_argument('--duration', help='Omit for no expiry, or use 7d, 30d, etc.')
    for name in ('status', 'revoke'):
        command = commands.add_parser(name)
        command.add_argument('--project', required=True)
    run = commands.add_parser('run', help='Run an application with its project virtual key injected.')
    run.add_argument('--project', required=True)
    run.add_argument('--session-id', help='Reuse this ID across turns of one conversation.')
    run.add_argument('program', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == 'models':
        result = {'models': Gateway().models()}
    elif args.command == 'doctor':
        gateway = Gateway()
        result = {'gateway': gateway.base, 'health': gateway.request('GET', '/health/readiness'),
                  'windows_hello': hello('Check'), 'credential_store': 'Windows Credential Manager'}
    else:
        project = project_path(args.project)
        store = WindowsCredentials()
        if args.command == 'provision':
            spec = request_spec(args.app or project.name, args.models, args.budget, args.duration)
            with project_lock(project):
                result = provision(project, spec, Gateway(), store)
        elif args.command == 'run':
            program = args.program[1:] if args.program[:1] == ['--'] else args.program
            if not program:
                raise BrokerError('Specify the application after --.')
            # The command runs with the project's normal Windows user permissions.
            return subprocess.run(program, cwd=project,
                                  env=project_environment(project, store, args.session_id)).returncode
        elif args.command == 'status':
            config = load_config(project)
            if not config:
                result = {'status': 'not_configured', 'project': str(project)}
            else:
                info = Gateway().info(config['key_hash'])
                secret = store.read(credential_target(project))
                result = {'status': info.get('status'), 'project': str(project), 'models': info.get('models'),
                          'expires': info.get('expires'), 'daily_budget': info.get('max_budget'),
                          'spent_this_period': info.get('spend'), 'budget_duration': info.get('budget_duration'),
                          'credential_present': bool(secret and key_hash(secret) == config['key_hash'])}
        else:
            config = load_config(project)
            if not config:
                raise BrokerError('Project is not configured.')
            secret = store.read(credential_target(project))
            if not secret or key_hash(secret) != config['key_hash']:
                raise BrokerError('The local key is missing. Revoke this project key in the dashboard.')
            with project_lock(project):
                # Re-read after acquiring the lock so a concurrent grant cannot be revoked accidentally.
                config = load_config(project)
                secret = store.read(credential_target(project))
                if not config or not secret or key_hash(secret) != config['key_hash']:
                    raise BrokerError('Project credential changed; check its status and try again.')
                Gateway().revoke(secret)
                store.delete(credential_target(project))
                (project / CONFIG_NAME).unlink()
            result = {'status': 'revoked', 'project': str(project)}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(cli())
    except KeyboardInterrupt:
        print('Canceled.', file=sys.stderr)
        raise SystemExit(130)
    except (BrokerError, OSError, subprocess.SubprocessError) as exc:
        print('ZeroKey: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
