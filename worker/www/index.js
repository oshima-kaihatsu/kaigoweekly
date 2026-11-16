// www.kaigoweekly.jp へのアクセスを、すべて https://kaigoweekly.jp の同じパスへ 301 で転送する（URLを1つにまとめるため）
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.hostname = 'kaigoweekly.jp';
    url.protocol = 'https:';
    return Response.redirect(url.toString(), 301);
  },
};
