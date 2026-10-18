# edit-check

Claude がファイルを変更したら、作業を終える前に、そのプロジェクトの型チェックや lint（コードの書き方の点検）を自動で実行する mod です。

CLAUDE.md に「型チェックを通す」と書いておいても、守られるかどうかは Claude しだいです。この mod は、変更があったときに必ずチェックを実行し、通らなければ結果を Claude に渡して直させます。

## 動き方

1. Claude（またはサブエージェント）がファイルを変更すると、そのファイルが入っているプロジェクトを覚えておきます。
2. Claude が返事を終えようとしたときに、覚えておいたプロジェクトのチェックをまとめて実行します。変更のたびではなく最後に1回なので、作業が遅くなりません。
3. 全部通れば、画面下に「自動チェック ✓」と出て、そのまま終わります。
4. 通らなければ、エラーの内容を Claude に渡して、直してから終えるように伝えます。直したら、もう一度チェックします。

同じエラーが2回続いたとき（もともとあった、今回の変更と関係ない問題など）や、3回続けて止めたときは、それ以上は止めずに終わらせて知らせます。Claude がチェックに閉じ込められることはありません。

## 何をチェックするか

プロジェクトにあるファイルを見て自動で決めます。

| プロジェクトにあるもの | 実行するチェック |
| --- | --- |
| `package.json` の `typecheck` / `lint` | `npm run typecheck`、`npm run lint`（pnpm・yarn・bun も自動で見分けます） |
| `typecheck` がなく `tsconfig.json` と TypeScript がある | `npx tsc --noEmit` |
| `pyproject.toml` の `[tool.ruff]` / `[tool.mypy]` | `ruff check .`、`mypy .` |
| `go.mod` | `go vet ./...` |
| `Cargo.toml` | `cargo check --quiet` |
| `.claude-plugin/plugin.json`（mod） | `claude plugin validate .` |

ツールが入っていないときは、失敗ではなく「飛ばした」として扱います。ホームフォルダ直下や、どのプロジェクトにも入っていないファイル（設定ファイルなど）はチェックしません。

### チェックを自分で決める

プロジェクトに `.claude/edit-check.json` を置くと、そちらが優先されます。

```json
{ "commands": ["npm run typecheck", "npm test"] }
```

`"commands": []` にすると、そのプロジェクトではチェックしません。

## 使い方

| 打つもの | 動き |
| --- | --- |
| `/edit-check` | 最後のチェック結果と、次に確かめるプロジェクトを表示 |
| `/edit-check off` | このセッションではチェックを止める |
| `/edit-check on` | 再開する |

## 設定

`/config` に「チェック1件の制限時間（秒）」が出ます。初期設定は300秒（最大600秒）です。

## インストール

Claude Code の入力欄で:

```
/plugin install edit-check --marketplace arima12345/claude-mods
```

マーケットプレイスを追加するか聞かれたら `y`、続けてインストール先（スコープ）を選びます。

シェルからは:

```
claude plugin install edit-check --marketplace arima12345/claude-mods
```

## 注意

- 組織が管理している Claude Code では、止まる瞬間への割り込みが効きません（個人のプランでは問題ありません）。
- goal2 と一緒に使えます。どちらも Claude が終わろうとした瞬間に動き、どちらかが「まだ終わらないで」と判断すれば、Claude は作業を続けます。
