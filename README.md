# claude-mods

有馬が作った Claude Code の mod をまとめたリポジトリです。

| mod | 内容 |
| --- | --- |
| [progress-panel](plugins/progress-panel) | Claude の進捗（作業中か、いま何をしているか、やることリストの進み具合）、利用枠・コンテキストの残り、サブエージェント、作業ログ、同じマシンのほかのセッションの状況をひと目で見せるパネル。使いすぎそうなときは知らせる |
| [goal2](plugins/goal2) | `/goal` の改良版。本当に達成したときだけ終わり、エラーで止まっても自動で再開する |
| [edit-check](plugins/edit-check) | ファイルを変更したら、作業を終える前にそのプロジェクトの型チェックや lint を自動で実行する |
| [compact-memo](plugins/compact-memo) | 会話の圧縮で決定事項が抜けないよう要約に指示し、ゴール・やることの残り・ブランチ・コミットをメモにして圧縮後の Claude へ渡し直す |
| [ja-reply](plugins/ja-reply) | Claude の報告がほとんど英語だったら、同じターンの中で日本語に書き直させる |
| [phone-notify](plugins/phone-notify) | 入力待ちで止まったとき、長い作業が終わったとき、エラーで止まったときに、ntfy でスマホへ通知する。ほかの mod の通知もスマホに転送する |
| [agents-guard](plugins/agents-guard) | AGENTS.md が目安（100行・6,000字）を超えたときや、ルートの CLAUDE.md に @AGENTS.md 以外の中身があるときに知らせる |

## インストール

Claude Code の入力欄で、入れたい mod の名前を指定します:

```
/plugin install progress-panel --marketplace arima12345/claude-mods
```

マーケットプレイスを追加するか聞かれたら `y`、続けてインストール先（スコープ）を選びます。デスクトップアプリでは、入力欄の横の + から Plugins を開き、Add marketplace に `arima12345/claude-mods` を入れてから Add plugin を選びます。
