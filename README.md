# Backup to S3

Cloudflare Workers + R2 multipart upload로 파일·폴더를 업로드하는 사이트입니다.

## 실행 및 배포

```sh
npm install
npm run types
npm run check
npm run dev
```

로컬 개발은 로컬 R2 저장소를 사용합니다. 실제 R2 다운로드 도메인은 로컬 객체를 제공하지 않습니다. 운영 배포:

```sh
npx wrangler login
npm run deploy
```

Cloudflare 계정에 기존 `backup-to-r2` 버킷과 `sjang.dev` zone이 있어야 합니다. 여러 계정이 있으면 Wrangler 설정에 해당 `account_id`를 추가하세요.

- 사이트: `https://backup-to-s3.sjang.dev` — `wrangler.jsonc`의 custom domain route
- 파일 URL: `https://r2.backup-to-s3.sjang.dev` — `R2_PUBLIC_URL` 변수
- R2 대시보드에서 버킷의 Custom Domains에 `r2.backup-to-s3.sjang.dev`를 연결해야 실제 파일 링크가 동작합니다. Wrangler 변수만으로 R2 도메인이 연결되지는 않습니다.
- Lifecycle 정책은 버킷 설정에 따르며, 적용 여부 및 보관 기간을 보장하지 않습니다. 이 프로젝트는 lifecycle rule을 변경하지 않습니다. 파일은 언제든 삭제될 수 있습니다.

## 동작

파일과 폴더 선택 및 드래그앤드롭을 지원합니다. 폴더 구조를 보존하며 빈 폴더는 별도로 저장하지 않습니다. 업로드 묶음별 경로는 UTC 기준 `yy/mm/dd/hh/mm/ss/<seed>/<random>/<values>/<상대 파일 경로>`입니다. 세 난수 구간은 암호학적 난수로 생성합니다.

32–90 MiB의 동일 크기 조각(마지막 조각 제외)을 파일별로 순차 전송하고 최대 3개 파일을 병렬 업로드합니다. 파일 전체를 메모리로 읽지 않으며 Worker는 요청 본문을 R2로 스트리밍합니다. 조각별 최대 5회 시도, 실시간 전송량·속도·남은 시간, 개별 파일 URL 복사, 공유 페이지, 전체 URL 목록 저장을 제공합니다. 공유 페이지는 완료된 파일을 페이지네이션하여 조회합니다.

일시정지는 진행 중인 조각을 마친 뒤 적용됩니다. 취소는 진행 중인 요청과 미완료 multipart upload를 중단합니다. 완료된 파일은 유지합니다. 실패 후 같은 페이지에서 다시 시도하면 완료된 조각을 재사용합니다. 페이지를 닫거나 새로고침한 뒤 이어올리기는 지원하지 않습니다. 업로드하는 동안 브라우저를 열어두고 컴퓨터가 절전 상태로 들어가지 않도록 하세요.

Worker 요청 크기 100 MB 제한 아래에서 동작하도록 파일당 최대 90 MiB × 10,000 = 약 879 GiB로 제한합니다. 폴더 총 용량은 여러 파일로 분산되므로 이 제한보다 클 수 있습니다. 무료 Workers의 일일 요청 제한과 별개로 수백 GB 업로드는 조각마다 요청이 발생합니다.

현재 업로드 페이지는 공개되어 있습니다. 개인용으로 접근을 제한하려면 Cloudflare Access에서 사이트 도메인에 접근 정책을 설정하세요. R2 다운로드 도메인은 공개 파일 공유용이며, 무작위 링크를 가진 사람은 다운로드할 수 있습니다. 다운로드 도메인의 장기 캐시 설정은 삭제 이후에도 캐시된 파일을 제공할 수 있으므로 버킷의 삭제 정책에 맞게 설정하세요.

## 확인

```sh
npm run types
npm run check
npm run build
```

공식 문서: [R2 multipart API](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## 저장소 및 주의사항

업로드 저장소 옵션은 현재 `r2`(Cloudflare R2, S3 호환 스토리지) 하나입니다. 기존 버킷 이름과 Worker 이름은 `backup-to-r2`를 유지합니다. 향후 S3를 추가할 때는 저장소별 업로드 API와 파일 URL 도메인을 연결해야 합니다. 현재 S3 업로드 기능은 구현하지 않습니다.

업로드 화면과 공유 화면에는 별도 데이터 암호화 없음, 데이터 무결성 보장 없음, 언제든 서비스 중단 가능, Lifecycle 적용 여부 및 보관 기간 보장 없음, 언제든 파일 삭제 가능이라는 Disclaimer을 표시합니다.

공유 페이지 경로는 `/share/r2/<업로드 묶음 경로>`입니다. 저장소 식별자를 사용하여 R2 파일 목록을 페이지네이션 조회하고, 다운로드는 `R2_PUBLIC_URL`로 생성한 버킷 직접 링크를 사용합니다. 현재 지원 저장소는 `r2`이며 기존 `/share/<업로드 묶음 경로>` 링크도 R2 목록으로 조회합니다.

## 저장소 확장 구조

`src/storage.ts`의 `StorageProvider`는 파일 목록, 빈 파일 저장, 객체 존재 확인, multipart 생성·재개·전송·완료·취소와 저장소별 용량 제한 및 공개 URL을 정의합니다. 새 저장소 어댑터를 작성하고 `storageProviders()`에 등록하면 `/api/storages`를 통해 선택 옵션에 노출됩니다. 모든 업로드 API와 `/share/<storage-id>/<경로>`는 해당 어댑터를 사용합니다. 브라우저는 저장소 종류를 분기하지 않으며, 저장소별 용량 제한을 동적으로 표시합니다. 실제 S3 지원에는 S3 어댑터 및 자격 증명 설정이 필요합니다.

## 제한된 전체 ZIP 다운로드

공유 페이지는 파일·폴더를 구분하지 않고 업로드 묶음 전체를 ZIP으로 다운로드할 수 있습니다. 서버는 합계가 128,000,000바이트 미만인지 다시 확인하며, 최대 900개 파일 및 경로 합계 2 MiB 제한도 적용합니다. ZIP은 파일별로 순차 읽고 64 KiB 조각으로 압축하여 응답 스트림으로 전송합니다. Worker 또는 브라우저 JavaScript에서 전체 파일·ZIP을 메모리에 누적하지 않습니다. 개별 다운로드는 기존 저장소 직접 URL을 사용합니다. 원래 업로드에서 보존되지 않은 빈 폴더, macOS 확장 속성, 심볼릭 링크는 ZIP으로 복원되지 않습니다. 압축 중 파일 삭제나 서비스 중단이 발생하면 다운로드가 실패할 수 있습니다.
