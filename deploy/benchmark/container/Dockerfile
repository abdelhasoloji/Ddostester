FROM php:8.4-fpm-alpine@sha256:78cd8de9970a9cd6ff4d98860a94eb5bf37dd2d5776b4785562dbfad01c29d5a
RUN apk add --no-cache nginx && mkdir -p /run/nginx && chown -R www-data:www-data /run/nginx /var/lib/nginx /var/log/nginx
COPY --chown=www-data:www-data deploy/benchmark/www /var/www/benchmark
RUN find /var/www/benchmark -type d -exec chmod 755 {} + && find /var/www/benchmark -type f -exec chmod 644 {} +
COPY deploy/benchmark/container/nginx.conf /etc/nginx/nginx.conf
COPY deploy/benchmark/container/pool.conf /usr/local/etc/php-fpm.d/zz-lab.conf
COPY deploy/benchmark/container/start.sh /usr/local/bin/lab-start
RUN chmod 755 /usr/local/bin/lab-start
USER www-data
EXPOSE 8080
CMD ["/usr/local/bin/lab-start"]
