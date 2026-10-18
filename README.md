# claude-mods

有馬が作った Claude Code の mod をまとめたリポジトリです。

| mod | 内容 |
| --- | --- |
| [progress-panel](plugins/progress-panel) | Claude の進捗（作業中か、いま何をしているか、やることリストの進み具合）をひと目で見せるパネル |
| [goal2](plugins/goal2) | `/goal` の改良版。本当に達成したときだけ終わり、エラーで止まっても自動で再開する |

## インストール

Claude Code の入力欄で、入れたい mod の名前を指定します:

```
/plugin install progress-panel --marketplace arima12345/claude-mods
```

マーケットプレイスを追加するか聞かれたら `y`、続けてインストール先（スコープ）を選びます。デスクトップアプリでは、入力欄の横の + から Plugins を開き、Add marketplace に `arima12345/claude-mods` を入れてから Add plugin を選びます。
