// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! S3 attachment writes through the same SigV4 signer as attachment reads.
use async_trait::async_trait;
use brz_http::{Client, Method, Response};

use super::{
    AttachmentUploadBackend, ImagePid, ImageUploadRequest, StoreObjectRequest, UploadBackendError,
};
use crate::attachments::{minio_client, s3_signing};
use minio_client::{MinioConfig, encode_object_path};

mod diagnostics;
use diagnostics::{check_response, protocol_error, transport_error};

const MIN_PART_SIZE: usize = 5 * 1024 * 1024;
const MAX_PART_COUNT: usize = 10_000;

/// Configurable object storage for the public attachment-upload handler.
pub struct S3StorageBackend {
    http: Client,
    config: MinioConfig,
}

impl S3StorageBackend {
    /// Retain the process-owned transport and selected bucket configuration.
    pub fn new(http: Client, config: MinioConfig) -> Self {
        Self { http, config }
    }

    async fn send(
        &self,
        method: Method,
        uri: &str,
        body: &[u8],
        extra_headers: &[(&str, &str)],
        stage: &'static str,
    ) -> Result<Response, UploadBackendError> {
        let host = self.config.host();
        let date = s3_signing::amz_timestamp_now();
        let hash = s3_signing::hex_sha256(body);
        let length = body.len().to_string();
        let mut headers = vec![
            ("host", host),
            ("content-length", length.as_str()),
            ("x-amz-date", date.as_str()),
            ("x-amz-content-sha256", hash.as_str()),
        ];
        headers.extend_from_slice(extra_headers);
        let signed = s3_signing::sign_headers(
            &self.config.access_key,
            &self.config.secret_key,
            &self.config.region,
            method.as_str(),
            uri,
            &date,
            &hash,
            &headers,
        );
        let url = format!("{}://{host}{uri}", self.config.scheme());
        let mut request = self
            .http
            .request(method, url)
            .map_err(|_| protocol_error(stage, "invalid_request"))?
            .header("authorization", signed.authorization)
            .header("content-length", length)
            .header("x-amz-date", signed.amz_date)
            .header("x-amz-content-sha256", signed.content_sha256)
            .header("user-agent", "MinIO (Linux; x86_64) minio-py/7.2.20")
            .header("accept-encoding", "identity");
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        let response = request
            .body(body.to_vec())
            .send()
            .await
            .map_err(|error| transport_error(stage, &error))?;
        check_response(response, stage).await
    }

    async fn put(&self, request: StoreObjectRequest<'_>) -> Result<(), UploadBackendError> {
        let uri = format!(
            "/{}/{}",
            self.config.bucket,
            encode_object_path(request.key)
        );
        let filename = encode_object_path(request.filename).replace('/', "%2F");
        let user_id = request.user_id.to_string();
        let metadata = [
            ("content-type", request.mime_type),
            ("x-amz-meta-filename", filename.as_str()),
            ("x-amz-meta-user_id", user_id.as_str()),
        ];
        let part_size = part_size(request.data.len());
        if request.data.len() <= part_size {
            self.send(Method::PUT, &uri, request.data, &metadata, "put_object")
                .await?;
            return Ok(());
        }
        let initialized = self
            .send(
                Method::POST,
                &format!("{uri}?uploads="),
                &[],
                &metadata,
                "create_multipart_upload",
            )
            .await?
            .bytes()
            .await
            .map_err(|error| transport_error("create_multipart_upload", &error))?;
        let xml = std::str::from_utf8(&initialized)
            .map_err(|_| protocol_error("create_multipart_upload", "invalid_xml"))?;
        let upload_id = xml_element(xml, "UploadId")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| protocol_error("create_multipart_upload", "missing_upload_id"))?;
        let query_id = encode_object_path(upload_id).replace('/', "%2F");
        let upload_uri = format!("{uri}?uploadId={query_id}");
        if let Err(error) = self
            .upload_parts(&uri, &upload_uri, &query_id, request.data, part_size)
            .await
        {
            // Abort against the real store so failed requests leave no partial upload.
            let _ = self
                .send(
                    Method::DELETE,
                    &upload_uri,
                    &[],
                    &[],
                    "abort_multipart_upload",
                )
                .await;
            return Err(error);
        }
        Ok(())
    }

    async fn upload_parts(
        &self,
        object_uri: &str,
        upload_uri: &str,
        upload_id: &str,
        data: &[u8],
        part_size: usize,
    ) -> Result<(), UploadBackendError> {
        let mut completion = String::from(
            "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        for (index, part) in data.chunks(part_size).enumerate() {
            let number = index + 1;
            let uri = format!("{object_uri}?partNumber={number}&uploadId={upload_id}");
            let response = self
                .send(Method::PUT, &uri, part, &[], "upload_part")
                .await?;
            let etag = response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| protocol_error("upload_part", "missing_etag"))?;
            completion.push_str(&format!(
                "<Part><PartNumber>{number}</PartNumber><ETag>{etag}</ETag></Part>"
            ));
        }
        completion.push_str("</CompleteMultipartUpload>");
        let digest = base64_md5(completion.as_bytes());
        let response = self
            .send(
                Method::POST,
                upload_uri,
                completion.as_bytes(),
                &[
                    ("content-type", "application/xml"),
                    ("content-md5", &digest),
                ],
                "complete_multipart_upload",
            )
            .await?;
        // S3 may send HTTP 200 followed by an XML Error during completion.
        let body = response
            .bytes()
            .await
            .map_err(|error| transport_error("complete_multipart_upload", &error))?;
        if String::from_utf8_lossy(&body).contains("<Error>") {
            return Err(protocol_error(
                "complete_multipart_upload",
                "embedded_error",
            ));
        }
        Ok(())
    }
}

#[async_trait]
impl AttachmentUploadBackend for S3StorageBackend {
    fn backend_type(&self) -> &str {
        "minio"
    }

    async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
        minio_client::ensure_bucket_exists(&self.http, &self.config)
            .await
            .map_err(|_| UploadBackendError)
    }

    async fn store_object(
        &self,
        request: StoreObjectRequest<'_>,
    ) -> Result<bool, UploadBackendError> {
        self.put(request).await?;
        Ok(true)
    }

    async fn upload_image_pid(&self, _request: ImageUploadRequest<'_>) -> Option<ImagePid> {
        None
    }

    async fn delete_object(&self, key: &str) -> Result<bool, UploadBackendError> {
        minio_client::delete_object(&self.http, &self.config, key)
            .await
            .map(|()| true)
            .map_err(|_| UploadBackendError)
    }
}

fn part_size(length: usize) -> usize {
    length
        .div_ceil(MAX_PART_COUNT)
        .div_ceil(MIN_PART_SIZE)
        .max(1)
        * MIN_PART_SIZE
}

fn xml_element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let (_, rest) = xml.split_once(&format!("<{name}>"))?;
    let (value, _) = rest.split_once(&format!("</{name}>"))?;
    Some(value)
}

fn base64_md5(body: &[u8]) -> String {
    use base64::Engine as _;
    use md5::{Digest as _, Md5};
    base64::engine::general_purpose::STANDARD.encode(Md5::digest(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_parts_match_minio_limits() {
        for length in [
            0,
            MIN_PART_SIZE - 1,
            MIN_PART_SIZE,
            MIN_PART_SIZE + 1,
            54 * 1024 * 1024,
        ] {
            assert_eq!(part_size(length), MIN_PART_SIZE);
        }
        assert_eq!(
            part_size(MIN_PART_SIZE * MAX_PART_COUNT + 1),
            2 * MIN_PART_SIZE
        );
    }
}
