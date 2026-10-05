# Linux에서 fork 빌드와 실행

이 안내는 Ubuntu/Debian 데스크톱에서 `Xeno-Song/t3code`의 `main`을 빌드해
터미널 명령으로 사용하는 방법입니다. 공식 설치 파일과 `npx t3@latest`는
원본 저장소의 릴리스를 사용하므로, 이 fork의 변경을 사용하려면 fork 소스를 빌드합니다.

## 최초 설치와 빌드

Node.js 24.13.1 이상인 24.x와 Vite+의 `vp`가 필요합니다. Linux 데스크톱의
네이티브 helper를 빌드할 도구와 헤더를 설치합니다.

```bash
sudo apt-get update
sudo apt-get install git curl build-essential libsecret-1-dev pkg-config
curl -fsSL https://vite.plus | bash
```

`vp` 설치 후 새 터미널을 열고 다음 명령을 실행합니다. 기본 소스 위치는
`~/src/t3code`입니다. 다른 위치를 선택했다면 아래 alias의 경로도 맞춥니다.

```bash
mkdir -p "$HOME/src"
git clone --branch main https://github.com/Xeno-Song/t3code.git "$HOME/src/t3code"
cd "$HOME/src/t3code"
vp env install
node --version
vp i
vp run build:desktop
```

`vp`의 환경 관리가 켜져 있으면 저장소의 `package.json`에 맞는 Node.js와
패키지 관리자를 선택합니다. `node --version`이 요구 버전인지 확인합니다.
[Vite+ 환경 관리](https://viteplus.dev/guide/env)에서 설정 방법을 확인할 수 있습니다.

빌드가 완료되면 실행합니다. 설치 패키지를 만드는 작업 없이 사용할 수 있습니다.
사용할 Provider의 설치와 로그인은 [설치 안내](./install.md#providers)를 따릅니다.

```bash
export T3CODE_HOME="$HOME/.t3"
node apps/desktop/scripts/start-electron.mjs
```

## 데이터 경로와 alias

다음 내용을 `~/.bashrc`에 한 번 추가합니다. `T3CODE_HOME`은 `userdata`가 아닌
`.t3` 루트까지 지정합니다. 이 예시의 대화·설정·온보딩 완료 기록은
`~/.t3/userdata`에 저장됩니다. 다른 T3 home을 사용하던 경우 그 경로로 맞춥니다.

```bash
export T3CODE_HOME="$HOME/.t3"
export T3CODE_SOURCE_DIR="$HOME/src/t3code"

alias t3code='(cd "$T3CODE_SOURCE_DIR" && node apps/desktop/scripts/start-electron.mjs)'
alias t3code-build='(cd "$T3CODE_SOURCE_DIR" && vp run build:desktop)'
alias t3code-update='(cd "$T3CODE_SOURCE_DIR" && git pull --ff-only && vp i && vp run build:desktop)'
```

현재 터미널에도 적용합니다.

```bash
source "$HOME/.bashrc"
```

| 명령            | 동작                                       |
| --------------- | ------------------------------------------ |
| `t3code`        | 빌드된 데스크톱 앱 실행                    |
| `t3code-build`  | 현재 소스로 다시 빌드                      |
| `t3code-update` | fork의 main을 내려받고 의존성 설치 후 빌드 |

alias 안에서만 소스 폴더로 이동하므로, 호출한 터미널의 현재 폴더는 유지됩니다.
일상적으로는 `t3code`만 실행하고, 소스를 수정하거나 업데이트한 뒤 다시 빌드합니다.
실행 중인 앱은 빌드 후 종료하고 다시 실행해야 새 코드가 적용됩니다.

설치 앱에서 쓰던 데이터를 이어서 사용하려면 같은 `T3CODE_HOME`을 지정하고,
같은 데이터를 사용하는 설치 앱을 먼저 종료합니다. 서로 다른 버전을 동시에
실행하면 별도 T3 home을 사용합니다. Bash 설정은 터미널 실행에 적용되며,
앱 아이콘 실행에는 별도 환경변수 설정이 필요합니다.

`vp run dev`와 `vp run dev:desktop`은 개발용 데이터 경로를 선택하므로,
위에서 빌드한 앱을 일상적으로 실행할 때는 `t3code`를 사용합니다.

## 브라우저로만 사용하기

저장소 루트에서 서버와 웹을 빌드한 뒤 실행합니다. `T3CODE_HOME`은 같은 방식으로 적용됩니다.

```bash
cd "$T3CODE_SOURCE_DIR"
vp run --filter t3 build
node apps/server/dist/bin.mjs
```

터미널에 표시되는 주소로 접속합니다. 서버도 소스 업데이트 후 다시 빌드하고
재시작합니다.
