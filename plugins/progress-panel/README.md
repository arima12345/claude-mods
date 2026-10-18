# progress-panel

Claude Code の進捗をひと目で見られるパネルを出す mod です。

- 作業中か待機中（入力待ち）か
- いま何をしているか（「コマンドを実行中」「Webで調べている」など）
- 経過時間とツールを使った回数
- やることリストの進み具合（■■■□□□ 1/3 と、✓ 完了・▶ 取り組み中・・ 未着手）。ターミナルのやることリストにも、デスクトップアプリのタスクリストにも対応しています

画面下のステータス欄にも「作業中 1/3・コマンドを実行中」のような一行が出ます。パネルを閉じたら `/progress` で開き直せます。

## インストール

Claude Code の入力欄で:

```
/plugin install progress-panel --marketplace arima12345/claude-mods
```

マーケットプレイスを追加するか聞かれたら `y`、続けてインストール先（スコープ）を選びます。

シェルからは:

```
claude plugin install progress-panel --marketplace arima12345/claude-mods
```

デスクトップアプリでは、入力欄の横の + から Plugins を開き、Add marketplace に `arima12345/claude-mods` を入れてから Add plugin を選びます。
